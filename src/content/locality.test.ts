import { describe, expect, it } from "vitest";
import { localityOf } from "./locality";

describe("localityOf", () => {
  it.each([
    ["Storgatan 12, 111 51 Stockholm", "Stockholm"],
    ["Södra vägen 45, 412 54 Göteborg", "Göteborg"],
    ["Storgatan 12, 11151 Stockholm", "Stockholm"],
    ["Storgatan 12, SE-111 51 Stockholm", "Stockholm"],
    ["Storgatan 12, 111 51 Upplands Väsby", "Upplands Väsby"],
    ["Storgatan 12, Stockholm", "Stockholm"],
  ])("%s gives %s", (address, town) => {
    expect(localityOf(address)).toBe(town);
  });

  it.each([[""], ["Storgatan 12"], ["Storgatan 12, 111 51"]])("finds no town in %j", (address) => {
    expect(localityOf(address)).toBeNull();
  });
});
