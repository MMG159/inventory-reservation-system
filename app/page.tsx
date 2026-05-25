"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type StockByWarehouse = {
  warehouseId: string;
  warehouseName: string;
  warehouseLocation: string;
  totalUnits: number;
  reservedUnits: number;
  availableUnits: number;
};

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: string | number;
  stockByWarehouse: StockByWarehouse[];
};

type ReserveResult = {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  status: "PENDING" | "CONFIRMED" | "RELEASED";
  expiresAt: string;
};

type ReservationHint = {
  id: string;
  expiresAt: string;
};

const RESERVATION_HINTS_STORAGE_KEY = "inventory:lastReservationHints";

function formatPrice(price: string | number) {
  const numeric = typeof price === "string" ? Number(price) : price;
  if (Number.isNaN(numeric)) return String(price);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(numeric);
}

export default function HomePage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reserveLoading, setReserveLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [reserveQuantity, setReserveQuantity] = useState<Record<string, number>>(
    {},
  );
  const [reserveMessage, setReserveMessage] = useState<Record<string, string>>(
    {},
  );
  const [reservationHint, setReservationHint] = useState<
    Record<string, ReservationHint>
  >({});

  async function loadProducts() {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch("/api/products", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Failed to load products");
      }

      const data = (await response.json()) as Product[];
      setProducts(data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error fetching products";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadProducts();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(RESERVATION_HINTS_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as Record<string, ReservationHint>;
      const now = Date.now();
      const activeHints = Object.fromEntries(
        Object.entries(parsed).filter(([, hint]) => {
          const expiresAtMs = new Date(hint.expiresAt).getTime();
          return Number.isFinite(expiresAtMs) && expiresAtMs > now;
        }),
      ) as Record<string, ReservationHint>;

      setReservationHint(activeHints);
    } catch {
      // Ignore malformed local storage data.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      RESERVATION_HINTS_STORAGE_KEY,
      JSON.stringify(reservationHint),
    );
  }, [reservationHint]);

  const hasProducts = useMemo(() => products.length > 0, [products]);

  async function handleReserve(
    productId: string,
    warehouseId: string,
    availableUnits: number,
  ) {
    const key = `${productId}:${warehouseId}`;
    const quantity = reserveQuantity[key] ?? 1;

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setReserveMessage((prev) => ({
        ...prev,
        [key]: "Quantity must be a positive whole number.",
      }));
      return;
    }

    if (quantity > availableUnits) {
      setReserveMessage((prev) => ({
        ...prev,
        [key]: "Quantity exceeds available stock.",
      }));
      return;
    }

    setReserveLoading((prev) => ({ ...prev, [key]: true }));
    setReserveMessage((prev) => ({ ...prev, [key]: "" }));

    try {
      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          productId,
          warehouseId,
          quantity,
        }),
      });

      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(errorPayload?.error ?? "Failed to reserve stock");
      }

      const reservation = (await response.json()) as ReserveResult;
      setReserveMessage((prev) => ({
        ...prev,
        [key]: `Reserved ${reservation.quantity} unit(s). Expires at ${new Date(
          reservation.expiresAt,
        ).toLocaleTimeString("en-US")}.`,
      }));
      setReservationHint((prev) => ({
        ...prev,
        [key]: {
          id: reservation.id,
          expiresAt: reservation.expiresAt,
        },
      }));

      await loadProducts();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error reserving stock";
      setReserveMessage((prev) => ({ ...prev, [key]: message }));
      setReservationHint((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } finally {
      setReserveLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  return (
    <main className="ui-shell min-h-screen p-5 md:p-10">
      <div className="mx-auto max-w-7xl">
        <header className="rise-in mb-8 rounded-3xl border border-[#d8d2c0] bg-[#f8f5ea]/90 p-6 md:p-8">
          <p className="emph-pill mb-4 inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em]">
            Inventory Console
          </p>
          <h1 className="text-4xl leading-tight text-[#1f2328] md:text-5xl">
            Reserve Stock Across Warehouses
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-[#45515a] md:text-base">
            Live availability, conflict-safe reservations, and checkout-ready
            holds with expiration tracking.
          </p>
        </header>

        {isLoading && (
          <p className="glass-card mt-8 rounded-2xl p-4 text-sm text-[#45515a]">
            Loading products...
          </p>
        )}

        {!isLoading && error && (
          <p className="mt-8 rounded-2xl border border-red-300 bg-red-100 p-4 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}

        {!isLoading && !error && !hasProducts && (
          <p className="glass-card mt-8 rounded-2xl p-4 text-sm text-[#45515a]">
            No products found.
          </p>
        )}

        {!isLoading && !error && hasProducts && (
          <section className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product, productIndex) => (
              <article
                key={product.id}
                className="glass-card rise-in rounded-3xl p-5 md:p-6"
                style={{ animationDelay: `${productIndex * 70}ms` }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl text-[#1f2328]">{product.name}</h2>
                    <p className="mt-1 text-sm font-medium uppercase tracking-wide text-[#4d6667]">
                      Product
                    </p>
                    <p className="mt-2 text-sm text-[#45515a]">
                      {product.description ?? "No description provided."}
                    </p>
                  </div>
                  <p className="emph-pill whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold">
                    {formatPrice(product.price)}
                  </p>
                </div>

                <div className="mt-5 space-y-3">
                  {product.stockByWarehouse.map((stock) => {
                    const key = `${product.id}:${stock.warehouseId}`;
                    const isReserving = reserveLoading[key] ?? false;
                    const availableOut = stock.availableUnits <= 0;
                    const successMessage = reserveMessage[key]?.startsWith("Reserved");
                    const latestHint = reservationHint[key];
                    const latestHintIsActive =
                      !!latestHint &&
                      new Date(latestHint.expiresAt).getTime() > Date.now();

                    return (
                      <div
                        key={stock.warehouseId}
                        className="rounded-2xl border border-[#d7d0bb] bg-[#f3efe1] p-4"
                      >
                        <p className="text-xl text-[#1f2328]">
                          {stock.warehouseName}
                        </p>
                        <p className="text-xs uppercase tracking-wider text-[#56626c]">
                          {stock.warehouseLocation}
                        </p>
                        <p className="mt-2 text-sm text-[#364047]">
                          Available Units:{" "}
                          <span className="font-bold text-[#1f2328]">
                            {stock.availableUnits}
                          </span>
                        </p>

                        <div className="mt-3 flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            value={reserveQuantity[key] ?? 1}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              setReserveQuantity((prev) => ({
                                ...prev,
                                [key]: Number.isFinite(next) ? next : 1,
                              }));
                            }}
                            className="w-20 rounded-xl border border-[#b9b3a3] bg-white px-3 py-2 text-sm text-[#1f2328] outline-none ring-0 transition focus:border-[#1f4a4d]"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              handleReserve(
                                product.id,
                                stock.warehouseId,
                                stock.availableUnits,
                              )
                            }
                            disabled={isReserving || availableOut}
                            className="primary-btn rounded-xl px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isReserving ? "Reserving..." : "Reserve"}
                          </button>
                        </div>

                        {reserveMessage[key] && (
                          <p
                            className={`mt-2 text-xs ${
                              successMessage
                                ? "text-emerald-800"
                                : "text-[var(--danger)]"
                            }`}
                          >
                            {reserveMessage[key]}
                          </p>
                        )}

                        {latestHintIsActive && (
                          <div className="mt-2 flex items-center justify-between gap-3">
                            <Link
                              href={`/checkout/${latestHint.id}`}
                              className="text-xs font-semibold text-[#1f4a4d] underline underline-offset-4"
                            >
                              {successMessage ? "Go to checkout" : "Resume checkout"}
                            </Link>
                            <span className="text-[10px] uppercase tracking-wide text-[#56626c]">
                              Hold until{" "}
                              {new Date(latestHint.expiresAt).toLocaleTimeString(
                                "en-US",
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
