"use client";

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

      await loadProducts();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected error reserving stock";
      setReserveMessage((prev) => ({ ...prev, [key]: message }));
    } finally {
      setReserveLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6 md:p-10">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold text-slate-900">Inventory</h1>
        <p className="mt-2 text-sm text-slate-600">
          Reserve units by product and warehouse.
        </p>

        {isLoading && (
          <p className="mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            Loading products...
          </p>
        )}

        {!isLoading && error && (
          <p className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </p>
        )}

        {!isLoading && !error && !hasProducts && (
          <p className="mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            No products found.
          </p>
        )}

        {!isLoading && !error && hasProducts && (
          <section className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => (
              <article
                key={product.id}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">
                      {product.name}
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      {product.description ?? "No description provided."}
                    </p>
                  </div>
                  <p className="whitespace-nowrap text-sm font-semibold text-slate-800">
                    {formatPrice(product.price)}
                  </p>
                </div>

                <div className="mt-4 space-y-3">
                  {product.stockByWarehouse.map((stock) => {
                    const key = `${product.id}:${stock.warehouseId}`;
                    const isReserving = reserveLoading[key] ?? false;
                    const availableOut = stock.availableUnits <= 0;

                    return (
                      <div
                        key={stock.warehouseId}
                        className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                      >
                        <p className="text-sm font-medium text-slate-800">
                          {stock.warehouseName}
                        </p>
                        <p className="text-xs text-slate-600">
                          {stock.warehouseLocation}
                        </p>
                        <p className="mt-2 text-sm text-slate-700">
                          Available:{" "}
                          <span className="font-semibold text-slate-900">
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
                            className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
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
                            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
                          >
                            {isReserving ? "Reserving..." : "Reserve"}
                          </button>
                        </div>

                        {reserveMessage[key] && (
                          <p className="mt-2 text-xs text-slate-700">
                            {reserveMessage[key]}
                          </p>
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

