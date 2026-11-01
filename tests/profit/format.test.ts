import { describe, expect, it } from "vitest";
import { fmtBtcFromSats, fmtHashrate, fmtNum, fmtSats, fmtUsd, orUnavailable } from "@/lib/profit/format";

describe("money formatting never turns a non-zero value into zero", () => {
  it("fmtUsd", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(-0.19437)).toBe("-$0.19");
    expect(fmtUsd(0.0049)).toBe("$0.00490");
    expect(fmtUsd(1.6e-7)).toBe("$0.000000160");
    expect(fmtUsd(-3.2e-9)).toBe("-$0.00000000320");
    expect(fmtUsd(1e-15)).toBe("$1.00e-15");
    for (const n of [1e-3, 5e-5, 2e-8, 1e-11, -1e-6]) expect(fmtUsd(n)).not.toMatch(/^-?\$0\.00$/);
  });
  it("fmtSats / fmtNum / fmtBtcFromSats", () => {
    expect(fmtSats(45.63)).toBe("45.63 sats");
    expect(fmtSats(0)).toBe("0 sats");
    expect(fmtSats(0.00021)).toBe("0.000210 sats");
    expect(fmtNum(12345.678)).toBe("12,345.68");
    expect(fmtBtcFromSats(45.63)).toBe("0.00000046 BTC");
    expect(fmtBtcFromSats(0.5)).toBe("0.00000000500 BTC");
    expect(fmtBtcFromSats(100_000_000)).toBe("1.00000000 BTC");
  });
  it("hashrate and unavailable", () => {
    expect(fmtHashrate(1.07e21)).toBe("1.07 ZH/s");
    expect(fmtHashrate(5e6)).toBe("5.00 MH/s");
    expect(orUnavailable(null, fmtUsd)).toBe("unavailable");
    expect(orUnavailable(2, fmtUsd)).toBe("$2.00");
    expect(fmtUsd(Number.NaN)).toBe("—");
  });
});
