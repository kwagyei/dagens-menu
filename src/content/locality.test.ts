import { describe, expect, it } from "vitest";
import { localityOf } from "./locality";

describe("localityOf", () => {
  it.each([
    ["Storgatan 12, 111 51 Stockholm", "Stockholm"],
    ["Södra vägen 45, 412 54 Göteborg", "Göteborg"],
    ["Storgatan 12, 11151 Stockholm", "Stockholm"],
    ["Storgatan 12, SE-111 51 Stockholm", "Stockholm"],
    ["Storgatan 12, 111 51 Upplands Väsby", "Upplands Väsby"],
    ["Storgatan 12, 111 51 Stockholm, Sverige", "Stockholm"],
    ["Storgatan 12, 111 51 Stockholm,", "Stockholm"],
    ["Storgatan 12\n111 51 Stockholm", "Stockholm"],
  ])("%s gives %s", (address, town) => {
    expect(localityOf(address)).toBe(town);
  });

  it.each([[""], ["Storgatan 12"], ["Strandvägen"], ["Storgatan 12, Stockholm"], ["Storgatan 12, 111 51"], ["Karl Johans gate 1, 0150 Oslo"]])("finds no town in %j", (address) => {
    expect(localityOf(address)).toBeNull();
  });
});
