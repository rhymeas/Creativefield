import { describe, expect, it } from "vitest";
import { assertPublicHost, isInternalAddress, isInternalName, publicTryout } from "../server/public-host";

describe("public try-out host guard", () => {
  it("knows the addresses that lead inside the host", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isInternalAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "104.18.0.1", "2606:4700::1111"]) expect(isInternalAddress(a), a).toBe(false);
  });
  it("refuses internal names without a lookup", async () => {
    for (const h of ["localhost", "postgres.railway.internal", "printer.local", "db"]) expect(isInternalName(h), h).toBe(true);
    await expect(assertPublicHost("127.0.0.1")).rejects.toThrow(/inside the host/);
    await expect(assertPublicHost("[::1]")).rejects.toThrow(/inside the host/);
    await expect(assertPublicHost("postgres.railway.internal")).rejects.toThrow(/inside the host/);
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });
  it("is off unless the variable is set", () => {
    expect(publicTryout({} as NodeJS.ProcessEnv)).toBe(false);
    expect(publicTryout({ COMFYFIELD_PUBLIC_TRYOUT: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("hex-form and embedded addresses", () => {
  it("refuses mapped, compatible, NAT64 and 6to4 forms written in hex", () => {
    for (const a of ["::ffff:7f00:1", "::ffff:a00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::1", "::ffff:169.254.169.254"]) expect(isInternalAddress(a), a).toBe(true);
    expect(isInternalAddress("2606:4700:4700::1111")).toBe(false);
  });
});
