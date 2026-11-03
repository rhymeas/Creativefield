import {describe, expect, it} from "vitest";
import {preparationFailureDetail} from "../server/execution";

const undici = (code: string) => Object.assign(new TypeError("fetch failed"), {cause: {code}});

describe("preparation failure details", () => {
  it("turns a raw fetch failure into a cause and a likely remedy", () => {
    expect(preparationFailureDetail(undici("ECONNREFUSED"))).toBe("could not reach the worker (ECONNREFUSED) — the worker refused the connection, so ComfyUI is probably not running on that origin");
    expect(preparationFailureDetail(undici("ENOTFOUND"))).toBe("could not reach the worker (ENOTFOUND) — the worker host name did not resolve");
    expect(preparationFailureDetail(undici("ETIMEDOUT"))).toBe("could not reach the worker (ETIMEDOUT) — the connection timed out");
    expect(preparationFailureDetail(undici("ECONNRESET"))).toBe("could not reach the worker (ECONNRESET) — the worker closed the connection");
  });

  it("keeps an unknown code without inventing a remedy", () => {
    expect(preparationFailureDetail(undici("EAI_AGAIN"))).toBe("could not reach the worker (EAI_AGAIN)");
  });

  it("says a timeout is a timeout", () => {
    const timeout = Object.assign(new Error("The operation was aborted"), {name: "TimeoutError"});
    expect(preparationFailureDetail(timeout)).toBe("the worker did not answer in time");
  });

  it("passes real messages through untouched", () => {
    expect(preparationFailureDetail(new Error("Worker upload failed (500): bad gateway"))).toBe("Worker upload failed (500): bad gateway");
    expect(preparationFailureDetail("something odd")).toBe("something odd");
  });
});
