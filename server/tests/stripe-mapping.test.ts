/**
 * Stripe → Pulse mapping tests. The webhook handler delegates all
 * translation to these helpers; if they're correct + the route just glues
 * them to setBillingState, the billing state machine is correct.
 */

import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  mapSubscriptionStatus,
  itemPeriodEnd,
  customerIdOf,
  customerIdOfSession,
} from "../src/lib/stripe-mapping";

describe("mapSubscriptionStatus", () => {
  test("maps active/trialing to themselves (the entitled states)", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("trialing");
  });

  test("collapses unpaid into past_due (same gate, no separate column)", () => {
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("unpaid")).toBe("past_due");
  });

  test("treats incomplete_expired and paused as canceled (no entitlement)", () => {
    expect(mapSubscriptionStatus("canceled")).toBe("canceled");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("canceled");
    expect(mapSubscriptionStatus("paused")).toBe("canceled");
  });

  test("preserves the initial 'incomplete' state", () => {
    expect(mapSubscriptionStatus("incomplete")).toBe("incomplete");
  });

  test("falls back to 'incomplete' for unknown status (fail-safe — no paid features)", () => {
    // @ts-expect-error — intentionally pass an out-of-enum value
    expect(mapSubscriptionStatus("future_unknown_status")).toBe("incomplete");
  });
});

describe("itemPeriodEnd", () => {
  test("converts unix-seconds to a Date", () => {
    const item = { current_period_end: 1700000000 } as unknown as Stripe.SubscriptionItem;
    const d = itemPeriodEnd(item);
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBe(1700000000 * 1000);
  });

  test("returns null when current_period_end is missing", () => {
    const item = {} as unknown as Stripe.SubscriptionItem;
    expect(itemPeriodEnd(item)).toBeNull();
  });

  test("returns null when current_period_end is null", () => {
    const item = { current_period_end: null } as unknown as Stripe.SubscriptionItem;
    expect(itemPeriodEnd(item)).toBeNull();
  });
});

describe("customerIdOf (Subscription)", () => {
  test("returns the string when customer is an id", () => {
    const sub = { customer: "cus_123" } as unknown as Stripe.Subscription;
    expect(customerIdOf(sub)).toBe("cus_123");
  });

  test("unwraps the .id when customer is an expanded object", () => {
    const sub = { customer: { id: "cus_456", deleted: false } } as unknown as Stripe.Subscription;
    expect(customerIdOf(sub)).toBe("cus_456");
  });
});

describe("customerIdOfSession", () => {
  test("returns the string when customer is an id", () => {
    const session = { customer: "cus_789" } as unknown as Stripe.Checkout.Session;
    expect(customerIdOfSession(session)).toBe("cus_789");
  });

  test("unwraps the expanded object id", () => {
    const session = { customer: { id: "cus_abc" } } as unknown as Stripe.Checkout.Session;
    expect(customerIdOfSession(session)).toBe("cus_abc");
  });

  test("returns null for guest checkouts where customer is null", () => {
    const session = { customer: null } as unknown as Stripe.Checkout.Session;
    expect(customerIdOfSession(session)).toBeNull();
  });
});
