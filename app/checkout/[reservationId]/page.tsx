"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type ReservationStatus = "PENDING" | "CONFIRMED" | "RELEASED";

type ReservationDetails = {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: string;
  product: {
    id: string;
    name: string;
    description: string | null;
    price: string | number;
  };
  warehouse: {
    id: string;
    name: string;
    location: string;
  };
};

type ReservationActionResponse = {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: string;
};

type Toast = {
  message: string;
  variant: "success" | "error";
};

function formatPrice(price: string | number) {
  const numeric = typeof price === "string" ? Number(price) : price;
  if (Number.isNaN(numeric)) return String(price);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(numeric);
}

function formatCountdown(ms: number) {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

export default function CheckoutReservationPage() {
  const params = useParams<{ reservationId: string }>();
  const router = useRouter();

  const [reservation, setReservation] = useState<ReservationDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [timeLeftMs, setTimeLeftMs] = useState(0);

  const reservationId =
    typeof params?.reservationId === "string" ? params.reservationId : "";

  async function loadReservation() {
    if (!reservationId) {
      setError("Invalid reservation id.");
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`/api/reservations/${reservationId}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? "Failed to load reservation.");
      }

      const data = (await response.json()) as ReservationDetails;
      setReservation(data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error loading reservation.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadReservation();
  }, [reservationId]);

  useEffect(() => {
    if (!reservation) return;

    const tick = () => {
      const next = new Date(reservation.expiresAt).getTime() - Date.now();
      setTimeLeftMs(next);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [reservation]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);

  const isExpired = useMemo(() => timeLeftMs <= 0, [timeLeftMs]);
  const isPending = reservation?.status === "PENDING";
  const actionDisabled = !isPending || isConfirming || isCancelling;

  async function executeAction(kind: "confirm" | "cancel") {
    if (!reservation) return;

    const endpoint =
      kind === "confirm"
        ? `/api/reservations/${reservation.id}/confirm`
        : `/api/reservations/${reservation.id}/release`;

    try {
      if (kind === "confirm") setIsConfirming(true);
      if (kind === "cancel") setIsCancelling(true);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Idempotency-Key": crypto.randomUUID(),
        },
      });

      const payload = (await response.json().catch(() => null)) as
        | ReservationActionResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        const message = payload && "error" in payload ? payload.error : "Action failed";

        if (response.status === 409 || response.status === 410) {
          setToast({
            variant: "error",
            message: message ?? "Reservation is no longer valid for this action.",
          });
        } else {
          setToast({
            variant: "error",
            message: message ?? "Could not complete request.",
          });
        }
        return;
      }

      const updated = payload as ReservationActionResponse;
      setReservation((prev) => (prev ? { ...prev, ...updated } : prev));
      setToast({
        variant: "success",
        message: kind === "confirm" ? "Purchase confirmed." : "Reservation cancelled.",
      });
    } catch {
      setToast({
        variant: "error",
        message: "Network error. Please try again.",
      });
    } finally {
      setIsConfirming(false);
      setIsCancelling(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6 md:p-10">
      <div className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="text-sm font-medium text-slate-700 underline underline-offset-4"
        >
          Back to products
        </button>

        <h1 className="mt-4 text-3xl font-bold text-slate-900">Checkout</h1>

        {toast && (
          <div
            className={`mt-4 rounded-lg border p-3 text-sm ${
              toast.variant === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
            role="alert"
          >
            {toast.message}
          </div>
        )}

        {isLoading && (
          <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            Loading reservation...
          </p>
        )}

        {!isLoading && error && (
          <p
            className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
            role="alert"
          >
            {error}
          </p>
        )}

        {!isLoading && !error && reservation && (
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Reservation #{reservation.id}
            </p>

            <h2 className="mt-2 text-xl font-semibold text-slate-900">
              {reservation.product.name}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {reservation.product.description ?? "No description provided."}
            </p>

            <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
              <p>
                Quantity: <span className="font-semibold">{reservation.quantity}</span>
              </p>
              <p>
                Price:{" "}
                <span className="font-semibold">
                  {formatPrice(reservation.product.price)}
                </span>
              </p>
              <p>
                Warehouse:{" "}
                <span className="font-semibold">{reservation.warehouse.name}</span>
              </p>
              <p>
                Location:{" "}
                <span className="font-semibold">{reservation.warehouse.location}</span>
              </p>
              <p>
                Status: <span className="font-semibold">{reservation.status}</span>
              </p>
              <p>
                Expires in:{" "}
                <span
                  className={`font-semibold ${
                    isExpired ? "text-red-700" : "text-slate-900"
                  }`}
                >
                  {isExpired ? "Expired" : formatCountdown(timeLeftMs)}
                </span>
              </p>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void executeAction("confirm")}
                disabled={actionDisabled}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isConfirming ? "Confirming..." : "Confirm purchase"}
              </button>
              <button
                type="button"
                onClick={() => void executeAction("cancel")}
                disabled={actionDisabled}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCancelling ? "Cancelling..." : "Cancel"}
              </button>
            </div>

            {isPending && isExpired && (
              <p
                className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700"
                role="alert"
              >
                This reservation has expired. Please create a new one.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
