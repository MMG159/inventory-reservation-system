import { ReservationStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type ReleaseSummary = {
  scanned: number;
  released: number;
  skipped: number;
  runAt: string;
};

export async function GET(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = request.headers.get("authorization");
      if (authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const now = new Date();

    const summary = await prisma.$transaction<ReleaseSummary>(async (tx) => {
      const expiredPending = await tx.reservation.findMany({
        where: {
          status: ReservationStatus.PENDING,
          expiresAt: {
            lte: now,
          },
        },
        select: {
          id: true,
          productId: true,
          warehouseId: true,
          quantity: true,
        },
      });

      let released = 0;
      let skipped = 0;

      for (const reservation of expiredPending) {
        const transitioned = await tx.reservation.updateMany({
          where: {
            id: reservation.id,
            status: ReservationStatus.PENDING,
            expiresAt: {
              lte: now,
            },
          },
          data: {
            status: ReservationStatus.RELEASED,
          },
        });

        // Reservation was already processed by another request.
        if (transitioned.count === 0) {
          skipped += 1;
          continue;
        }

        const stockUpdated = await tx.stock.updateMany({
          where: {
            productId: reservation.productId,
            warehouseId: reservation.warehouseId,
            reservedUnits: {
              gte: reservation.quantity,
            },
          },
          data: {
            reservedUnits: {
              decrement: reservation.quantity,
            },
          },
        });

        if (stockUpdated.count === 0) {
          throw new Error(
            `Stock invariant violation while releasing reservation ${reservation.id}.`,
          );
        }

        released += 1;
      }

      return {
        scanned: expiredPending.length,
        released,
        skipped,
        runAt: now.toISOString(),
      };
    });

    return NextResponse.json(summary);
  } catch (error) {
    console.error("Failed to release expired reservations:", error);
    return NextResponse.json(
      { error: "Failed to release expired reservations" },
      { status: 500 },
    );
  }
}

