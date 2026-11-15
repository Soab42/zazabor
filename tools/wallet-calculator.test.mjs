// The Wallet calculator's arithmetic (src/modules/wallet/calc-math.ts).
// Run: node --test tools/wallet-calculator.test.mjs   (Node 23.6+ reads the TypeScript directly)
import assert from "node:assert/strict";
import test from "node:test";
import { calculate, showNumber } from "../src/modules/wallet/calc-math.ts";

test("sums as typed, with the usual precedence and brackets", () => {
  assert.equal(calculate("1,250 + 750"), 2000);
  assert.equal(calculate("2 + 3 × 4"), 14);
  assert.equal(calculate("(2 + 3) * 4"), 20);
  assert.equal(calculate("11135 x 60"), 668100);
  assert.equal(calculate("10 ÷ 4"), 2.5);
  assert.equal(calculate("-5 + 2"), -3);
  assert.equal(calculate("5 − −2"), 7);
});

test("percent works like a pocket calculator", () => {
  assert.equal(calculate("1500 + 10%"), 1650);
  assert.equal(calculate("2000 - 15%"), 1700);
  assert.equal(calculate("200 * 5%"), 10);
  assert.equal(calculate("12%"), 0.12);
});

test("mistakes say what's wrong", () => {
  assert.throws(() => calculate("5 / 0"), /divide by zero/);
  assert.throws(() => calculate("5 +"), /Incomplete/);
  assert.throws(() => calculate("5 $ 2"), /Unexpected/);
});

test("answers are grouped in lakhs", () => {
  assert.equal(showNumber(1234567.891), "12,34,567.891");
  assert.equal(showNumber(0.1 + 0.2), "0.3");
});
