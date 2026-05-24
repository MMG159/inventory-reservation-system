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

const createReservationSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

class InsufficientStockError extends Error {
  status: number;

  constructor(message = "Insufficient stock for reservation") {
    super(message);
    this.name = "InsufficientStockError";
    this.status = 409;
  }
}

type CreateReservationInput = z.infer<typeof createReservationSchema>;

async function createReservation(input: CreateReservationInput) {
  const lockKey = `${input.productId}:${input.warehouseId}`;

  return withDistributedLock(lockKey, async () => {
    return prisma.$transaction(async (tx) => {
      const stock = await tx.stock.findUnique({
        where: {
          productId_warehouseId: {
            productId: input.productId,
            warehouseId: input.warehouseId,
          },
        },
      });

      if (!stock) {
        throw new InsufficientStockError("No stock found for this product/warehouse");
      }

      const availableUnits = stock.totalUnits - stock.reservedUnits;
      if (availableUnits < input.quantity) {
        throw new InsufficientStockError();
      }

      await tx.stock.update({
        where: { id: stock.id },
        data: {
          reservedUnits: {
            increment: input.quantity,
          },
        },
      });

      const reservation = await tx.reservation.create({
        data: {
          productId: input.productId,
          warehouseId: input.warehouseId,
          quantity: input.quantity,
          status: ReservationStatus.PENDING,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      return reservation;
    });
  });
}

function isZodError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = createReservationSchema.parse(body);
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();

    if (!idempotencyKey) {
      const reservation = await createReservation(parsed);
      return NextResponse.json(reservation, { status: 201 });
    }

    const result = await withIdempotency({
      request,
      scope: `reservation:create:${parsed.productId}:${parsed.warehouseId}:${parsed.quantity}`,
      handler: async () => createReservation(parsed),
    });

    return NextResponse.json(result.value, {
      status: 201,
      headers: {
        "Idempotency-Replayed": String(result.replayed),
      },
    });
  } catch (error) {
    if (isZodError(error)) {
      return NextResponse.json(
        {
          error: "Invalid request payload",
          details: error.flatten(),
        },
        { status: 400 },
      );
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        { error: "Database error while creating reservation" },
        { status: 500 },
      );
    }

    if (error instanceof InsufficientStockError) {
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
        { error: "Stock is busy. Please retry." },
        { status: 423 },
      );
    }

    console.error("Failed to create reservation:", error);
    return NextResponse.json(
      { error: "Failed to create reservation" },
      { status: 500 },
    );
  }
}

