import { getRedis, isRedisConfigured } from "./redis";

const RELEASE_PROCESSING_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

type ProcessingRecord = {
  state: "processing";
  ownerToken: string;
  createdAt: string;
};

type CompletedRecord<T> = {
  state: "completed";
  createdAt: string;
  value: T;
};

type IdempotencyRecord<T> = ProcessingRecord | CompletedRecord<T>;

type LocalIdempotencyEntry<T> = {
  record: IdempotencyRecord<T>;
  expiresAtMs: number;
};

type WithIdempotencyOptions<T> = {
  request: Request;
  scope: string;
  handler: () => Promise<T>;
  ttlSeconds?: number;
  processingTtlSeconds?: number;
};

export type IdempotencyResult<T> = {
  key: string;
  replayed: boolean;
  value: T;
};

export class MissingIdempotencyKeyError extends Error {
  status: number;

  constructor(message = "Missing Idempotency-Key header") {
    super(message);
    this.name = "MissingIdempotencyKeyError";
    this.status = 400;
  }
}

export class IdempotencyInProgressError extends Error {
  status: number;

  constructor(message = "This idempotent request is already in progress") {
    super(message);
    this.name = "IdempotencyInProgressError";
    this.status = 409;
  }
}

const globalForIdempotency = globalThis as unknown as {
  localIdempotencyMap:
    | Map<string, LocalIdempotencyEntry<unknown>>
    | undefined;
};

function getLocalIdempotencyMap() {
  if (!globalForIdempotency.localIdempotencyMap) {
    globalForIdempotency.localIdempotencyMap = new Map();
  }

  return globalForIdempotency.localIdempotencyMap;
}

function getLocalRecord<T>(key: string): IdempotencyRecord<T> | null {
  const map = getLocalIdempotencyMap();
  const value = map.get(key);

  if (!value) return null;
  if (value.expiresAtMs <= Date.now()) {
    map.delete(key);
    return null;
  }

  return value.record as IdempotencyRecord<T>;
}

function setLocalRecord<T>(
  key: string,
  record: IdempotencyRecord<T>,
  ttlSeconds: number,
) {
  const map = getLocalIdempotencyMap();
  map.set(key, {
    record,
    expiresAtMs: Date.now() + ttlSeconds * 1000,
  });
}

function clearLocalProcessingIfOwner(
  key: string,
  processingValue: string,
) {
  const map = getLocalIdempotencyMap();
  const current = map.get(key);
  if (!current) return;

  const expected = parseRecord<unknown>(processingValue);
  if (!expected || expected.state !== "processing") return;

  const active = current.record;
  if (
    active.state === "processing" &&
    active.ownerToken === expected.ownerToken
  ) {
    map.delete(key);
  }
}

function parseRecord<T>(raw: string | null): IdempotencyRecord<T> | null {
  if (!raw) return null;

  try {
    return JSON.parse(raw) as IdempotencyRecord<T>;
  } catch {
    return null;
  }
}

export function getIdempotencyKeyFromRequest(request: Request): string {
  const key = request.headers.get("Idempotency-Key")?.trim();

  if (!key) {
    throw new MissingIdempotencyKeyError();
  }

  return key;
}

export async function withIdempotency<T>({
  request,
  scope,
  handler,
  ttlSeconds = 60 * 60 * 24,
  processingTtlSeconds = 60,
}: WithIdempotencyOptions<T>): Promise<IdempotencyResult<T>> {
  const idempotencyKey = getIdempotencyKeyFromRequest(request);
  const storageKey = `idempotency:${scope}:${idempotencyKey}`;

  if (!isRedisConfigured()) {
    return withLocalIdempotency({
      storageKey,
      idempotencyKey,
      handler,
      ttlSeconds,
      processingTtlSeconds,
    });
  }

  const redis = getRedis();

  const existing = parseRecord<T>(await redis.get<string>(storageKey));
  if (existing?.state === "completed") {
    return {
      key: idempotencyKey,
      replayed: true,
      value: existing.value,
    };
  }

  if (existing?.state === "processing") {
    throw new IdempotencyInProgressError();
  }

  const ownerToken = crypto.randomUUID();
  const processingRecord: ProcessingRecord = {
    state: "processing",
    ownerToken,
    createdAt: new Date().toISOString(),
  };
  const processingValue = JSON.stringify(processingRecord);

  const acquired = await redis.set(storageKey, processingValue, {
    nx: true,
    ex: processingTtlSeconds,
  });

  if (acquired !== "OK") {
    const latest = parseRecord<T>(await redis.get<string>(storageKey));

    if (latest?.state === "completed") {
      return {
        key: idempotencyKey,
        replayed: true,
        value: latest.value,
      };
    }

    throw new IdempotencyInProgressError();
  }

  try {
    const value = await handler();
    const completedRecord: CompletedRecord<T> = {
      state: "completed",
      createdAt: new Date().toISOString(),
      value,
    };

    await redis.set(storageKey, JSON.stringify(completedRecord), {
      ex: ttlSeconds,
    });

    return {
      key: idempotencyKey,
      replayed: false,
      value,
    };
  } catch (error) {
    await redis.eval(RELEASE_PROCESSING_SCRIPT, [storageKey], [processingValue]);
    throw error;
  }
}

async function withLocalIdempotency<T>({
  storageKey,
  idempotencyKey,
  handler,
  ttlSeconds,
  processingTtlSeconds,
}: {
  storageKey: string;
  idempotencyKey: string;
  handler: () => Promise<T>;
  ttlSeconds: number;
  processingTtlSeconds: number;
}): Promise<IdempotencyResult<T>> {
  const existing = getLocalRecord<T>(storageKey);
  if (existing?.state === "completed") {
    return {
      key: idempotencyKey,
      replayed: true,
      value: existing.value,
    };
  }

  if (existing?.state === "processing") {
    throw new IdempotencyInProgressError();
  }

  const ownerToken = crypto.randomUUID();
  const processingRecord: ProcessingRecord = {
    state: "processing",
    ownerToken,
    createdAt: new Date().toISOString(),
  };
  const processingValue = JSON.stringify(processingRecord);
  setLocalRecord(storageKey, processingRecord, processingTtlSeconds);

  try {
    const value = await handler();
    const completedRecord: CompletedRecord<T> = {
      state: "completed",
      createdAt: new Date().toISOString(),
      value,
    };

    setLocalRecord(storageKey, completedRecord, ttlSeconds);

    return {
      key: idempotencyKey,
      replayed: false,
      value,
    };
  } catch (error) {
    clearLocalProcessingIfOwner(storageKey, processingValue);
    throw error;
  }
}
