import type { AppDatabase } from "@personal-ai/db/client";
import { describe, expect, it } from "vitest";
import { PostgresTaskStore } from "./task-repository.js";

function serializationFailure() {
  return Object.assign(new Error("serialization failure"), { code: "40001" });
}

describe("PostgresTaskStore serializable transaction retry", () => {
  it("opens a new transaction and repeats the complete callback", async () => {
    let transactions = 0;
    let operations = 0;
    const database = {
      async transaction(operation: (transaction: unknown) => Promise<string>) {
        transactions += 1;
        const result = await operation({ attempt: transactions });
        if (transactions < 3) throw serializationFailure();
        return result;
      }
    } as unknown as AppDatabase;

    const result = await new PostgresTaskStore(database).runSerializable(async () => {
      operations += 1;
      return "committed";
    });
    expect(result).toBe("committed");
    expect(transactions).toBe(3);
    expect(operations).toBe(3);
  });

  it("does not retry validation or application errors", async () => {
    let transactions = 0;
    const database = {
      async transaction(operation: (transaction: unknown) => Promise<unknown>) {
        transactions += 1;
        return operation({});
      }
    } as unknown as AppDatabase;
    const expected = new Error("invalid transition");
    await expect(new PostgresTaskStore(database).runSerializable(async () => {
      throw expected;
    })).rejects.toBe(expected);
    expect(transactions).toBe(1);
  });

  it("limits serialization retries to three attempts", async () => {
    let transactions = 0;
    const database = {
      async transaction(operation: (transaction: unknown) => Promise<unknown>) {
        transactions += 1;
        await operation({});
        throw serializationFailure();
      }
    } as unknown as AppDatabase;
    await expect(new PostgresTaskStore(database).runSerializable(async () => "never committed"))
      .rejects.toMatchObject({ code: "40001" });
    expect(transactions).toBe(3);
  });
});
