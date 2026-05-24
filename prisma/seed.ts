import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(async (tx) => {
    // Reset dependent data first to keep the seed idempotent.
    await tx.reservation.deleteMany();
    await tx.stock.deleteMany();
    await tx.product.deleteMany();
    await tx.warehouse.deleteMany();

    const products = await Promise.all([
      tx.product.create({
        data: {
          name: "Vitamin D3 5000 IU",
          description: "Daily supplement capsules for bone and immune support.",
          price: 19.99,
        },
      }),
      tx.product.create({
        data: {
          name: "Digital Thermometer",
          description: "Fast-read oral thermometer with fever alert.",
          price: 12.49,
        },
      }),
      tx.product.create({
        data: {
          name: "Compression Knee Sleeve",
          description: "Breathable knee support sleeve for daily activity.",
          price: 24.95,
        },
      }),
    ]);

    const warehouses = await Promise.all([
      tx.warehouse.create({
        data: {
          name: "Bengaluru Central Warehouse",
          location: "Bengaluru",
        },
      }),
      tx.warehouse.create({
        data: {
          name: "Mumbai West Warehouse",
          location: "Mumbai",
        },
      }),
    ]);

    const [vitaminD3, thermometer, kneeSleeve] = products;
    const [bengaluru, mumbai] = warehouses;

    await tx.stock.createMany({
      data: [
        {
          productId: vitaminD3.id,
          warehouseId: bengaluru.id,
          totalUnits: 180,
          reservedUnits: 24,
        },
        {
          productId: vitaminD3.id,
          warehouseId: mumbai.id,
          totalUnits: 120,
          reservedUnits: 8,
        },
        {
          productId: thermometer.id,
          warehouseId: bengaluru.id,
          totalUnits: 90,
          reservedUnits: 17,
        },
        {
          productId: thermometer.id,
          warehouseId: mumbai.id,
          totalUnits: 150,
          reservedUnits: 42,
        },
        {
          productId: kneeSleeve.id,
          warehouseId: bengaluru.id,
          totalUnits: 75,
          reservedUnits: 5,
        },
        {
          productId: kneeSleeve.id,
          warehouseId: mumbai.id,
          totalUnits: 60,
          reservedUnits: 19,
        },
      ],
    });
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("Seeding failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });

