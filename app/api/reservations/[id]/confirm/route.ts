import { Prisma, ReservationStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  IdempotencyInProgressError,
  MissingIdempotencyKeyError,
  withIdempotency,
} from "@/lib/idempotency";
import {
  LockAcquisitionError,
  withDistributedLock,
} from "@/lib/distributed-lock";
import { prisma } from "@/lib/prisma";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

class NotFoundError extends Error {
  status: number;

  constructor(message = "Reservation not found") {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
  }
}

class ReservationExpiredError extends Error {
  status: number;

  constructor(message = "Reservation has expired") {
    super(message);
    this.name = "ReservationExpiredError";
    this.status = 410;
  }
}

class ReservationConflictError extends Error {
  status: number;

  constructor(message: string) {
    super(message);
    this.name = "ReservationConflictError";
    this.status = 409;
  }
}

async function confirmReservation(reservationId: string) {
  const reservationForLock = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { productId: true, warehouseId: true },
  });

  if (!reservationForLock) {
    throw new NotFoundError();
  }

  const lockKey = `${reservationForLock.productId}:${reservationForLock.warehouseId}`;

  return withDistributedLock(lockKey, async () => {
    return prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation) {
        throw new NotFoundError();
      }

      if (reservation.status === ReservationStatus.CONFIRMED) {
        return reservation;
      }

      if (reservation.status === ReservationStatus.RELEASED) {
        throw new ReservationConflictError("Reservation is already released");
      }

      if (new Date() > reservation.expiresAt) {
        throw new ReservationExpiredError();
      }

      const stock = await tx.stock.findUnique({
        where: {
          productId_warehouseId: {
            productId: reservation.productId,
            warehouseId: reservation.warehouseId,
          },
        },
      });

      if (!stock) {
        throw new ReservationConflictError("Stock record not found");
      }

      if (
        stock.totalUnits < reservation.quantity ||
        stock.reservedUnits < reservation.quantity
      ) {
        throw new ReservationConflictError(
          "Stock invariants violated for this reservation",
        );
      }

      await tx.stock.update({
        where: { id: stock.id },
        data: {
          totalUnits: {
            decrement: reservation.quantity,
          },
          reservedUnits: {
            decrement: reservation.quantity,
          },
        },
      });

      return tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: ReservationStatus.CONFIRMED,
        },
      });
    });
  });
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = paramsSchema.parse(await context.params);
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();

    if (!idempotencyKey) {
      const reservation = await confirmReservation(id);
      return NextResponse.json(reservation, { status: 200 });
    }

    const result = await withIdempotency({
      request,
      scope: `reservation:confirm:${id}`,
      handler: async () => confirmReservation(id),
    });

    return NextResponse.json(result.value, {
      status: 200,
      headers: {
        "Idempotency-Replayed": String(result.replayed),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid reservation id" },
        { status: 400 },
      );
    }

    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof ReservationExpiredError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof ReservationConflictError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof IdempotencyInProgressError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof MissingIdempotencyKeyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof LockAcquisitionError) {
      return NextResponse.json(
        { error: "Reservation is busy. Please retry." },
        { status: 423 },
      );
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        { error: "Database error while confirming reservation" },
        { status: 500 },
      );
    }

    console.error("Failed to confirm reservation:", error);
    return NextResponse.json(
      { error: "Failed to confirm reservation" },
      { status: 500 },
    );
  }
}
