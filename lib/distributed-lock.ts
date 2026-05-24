import { getRedis, isRedisConfigured } from "./redis";

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class LockAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockAcquisitionError";
  }
}

type WithDistributedLockOptions = {
  ttlMs?: number;
  waitTimeoutMs?: number;
  retryDelayMs?: number;
  namespace?: string;
};

type LocalLockEntry = {
  ownerToken: string;
  expiresAt: number;
};

const globalForLocalLocks = globalThis as unknown as {
  localLockMap: Map<string, LocalLockEntry> | undefined;
};

function getLocalLockMap() {
  if (!globalForLocalLocks.localLockMap) {
    globalForLocalLocks.localLockMap = new Map<string, LocalLockEntry>();
  }

  return globalForLocalLocks.localLockMap;
}

async function releaseLock(lockKey: string, ownerToken: string) {
  const redis = getRedis();
  await redis.eval(RELEASE_LOCK_SCRIPT, [lockKey], [ownerToken]);
}

export async function withDistributedLock<T>(
  key: string,
  task: () => Promise<T>,
  options: WithDistributedLockOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? 8_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 4_000;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const namespace = options.namespace ?? "inventory-lock";

  const lockKey = `${namespace}:${key}`;
  const ownerToken = crypto.randomUUID();
  const deadline = Date.now() + waitTimeoutMs;

  if (!isRedisConfigured()) {
    return withLocalLock(lockKey, ownerToken, task, {
      ttlMs,
      waitTimeoutMs,
      retryDelayMs,
    });
  }

  const redis = getRedis();

  while (true) {
    const acquired = await redis
      .set(lockKey, ownerToken, {
        nx: true,
        px: ttlMs,
      })
      .catch(() => null);

    if (acquired === "OK") {
      try {
        return await task();
      } finally {
        await releaseLock(lockKey, ownerToken);
      }
    }

    if (Date.now() >= deadline) {
      throw new LockAcquisitionError(
        `Failed to acquire distributed lock for key "${key}" within ${waitTimeoutMs}ms.`,
      );
    }

    await sleep(retryDelayMs + Math.floor(Math.random() * 25));
  }
}

async function withLocalLock<T>(
  lockKey: string,
  ownerToken: string,
  task: () => Promise<T>,
  options: { ttlMs: number; waitTimeoutMs: number; retryDelayMs: number },
) {
  const lockMap = getLocalLockMap();
  const deadline = Date.now() + options.waitTimeoutMs;

  while (true) {
    const existing = lockMap.get(lockKey);

    if (!existing || existing.expiresAt <= Date.now()) {
      lockMap.set(lockKey, {
        ownerToken,
        expiresAt: Date.now() + options.ttlMs,
      });

      try {
        return await task();
      } finally {
        const current = lockMap.get(lockKey);
        if (current?.ownerToken === ownerToken) {
          lockMap.delete(lockKey);
        }
      }
    }

    if (Date.now() >= deadline) {
      throw new LockAcquisitionError(
        `Failed to acquire distributed lock for key "${lockKey}" within ${options.waitTimeoutMs}ms.`,
      );
    }

    await sleep(options.retryDelayMs + Math.floor(Math.random() * 25));
  }
}
