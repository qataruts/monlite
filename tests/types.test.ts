import { describe, it, expect } from "vitest";
import { createDb } from "../src/index";

/**
 * Type-level tests. The assertions below are checked by `tsc` (this dir is in the
 * typecheck include); the function is never executed. `@ts-expect-error` lines
 * MUST error, or typecheck fails — that's the test.
 */
export async function _typeChecks() {
  const db = createDb(":memory:");

  // --- a TYPED collection is strict --------------------------------------
  const users = db.collection<{ name: string; age: number }>("users");

  // valid: known fields + operators + dot-path nested filters
  await users.findMany({
    where: { age: { gte: 18 }, name: "Ali" },
    orderBy: { age: "desc" },
  });
  await users.findMany({ where: { "profile.city": "Doha" } }); // dot-path ok

  // @ts-expect-error unknown field in where
  await users.findMany({ where: { nope: 1 } });
  // @ts-expect-error unknown field in orderBy
  await users.findMany({ orderBy: { nope: "asc" } });
  // Notes on the limits: (1) per-field operator VALUE types are hinted but not
  // strictly enforced (operator objects are all-optional, so TS structurally
  // accepts primitives); (2) `select` keys aren't excess-checked because select
  // flows through a generic to narrow the return — an unknown select key simply
  // projects to nothing rather than erroring.

  // --- select narrows the return type ------------------------------------
  const picked = await users.findMany({ select: { name: true } });
  const _name: string = picked[0].name;
  // @ts-expect-error age was not selected
  const _missing = picked[0].age;

  // no select → full document (incl. system fields)
  const full = await users.findMany();
  const _age: number = full[0].age;
  const _id: string = full[0]._id;
  const _created: number = full[0].created_at;

  // findFirst narrows too
  const one = await users.findFirst({ select: { age: true } });
  const _oneAge: number | undefined = one?.age;

  // --- an UNTYPED (Doc) collection stays schema-free (non-breaking) -------
  const any = db.collection("misc");
  await any.findMany({ where: { whatever: 1, anything: { gte: 3 } } }); // ok, no error
  const m = await any.findMany({ select: { whatever: true } });
  const _w = m[0].whatever; // still any — no narrowing for Doc

  void _name;
  void _missing;
  void _age;
  void _id;
  void _created;
  void _oneAge;
  void _w;
}

describe("type-level inference (2.0)", () => {
  it("compiles (assertions enforced by tsc)", () => {
    expect(typeof _typeChecks).toBe("function");
  });
});
