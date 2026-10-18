/** Attacks on linkProblem's host check (L2). */
import { describe, expect, it } from "vitest";
import { linkProblem } from "../scripts/restore-photos";

const ok = (u: string, allow: string[] = []) => expect(linkProblem(new URL(u), allow)).toBeNull();
const no = (u: string, allow: string[] = []) => expect(linkProblem(new URL(u), allow)).not.toBeNull();

describe("linkProblem", () => {
  it("accepts the project's Workers, whatever the case or default port", () => {
    ok("https://dagens-menu-x.kwabenasasuboakye.workers.dev/media/a.webp");
    ok("https://DAGENS-MENU-X.kwabenasasuboakye.workers.dev:443/a");
  });
  it.each([
    "https://dagens-menu-x.kwabenasasuboakye.workers.dev./a",
    "https://dagens-menu-x.kwabenasasuboakye.workers.dev:8443/a",
    "https://dagens-menu-x.kwabenasasuboakye.workers.dev.evil.example/a",
    "https://evil.example/dagens-menu-x.kwabenasasuboakye.workers.dev",
    "http://dagens-menu-x.kwabenasasuboakye.workers.dev/a",
    "https://[::1]/a",
    "https://127.0.0.1/a",
    "https://xn--dagens-menu-x-9ib.kwabenasasuboakye.workers.dev/a",
    "https://dagens-menu-x.kwabenasasuboakye.workers.dev%2eevil.example/a",
  ])("refuses %s", (u) => no(u));
  it.each([[""], ["*"], ["localhost:"], ["  "], ["https://"], ["://"], ["."]])("allow-host %j does not open other hosts", (a) => {
    no("https://evil.example/a", [a]);
    no("http://169.254.169.254/a", [a]);
    no("http://[::1]/a", [a]);
  });
  it("an allow-host matches host and port exactly", () => {
    ok("http://localhost:8790/a", ["localhost:8790"]);
    no("http://localhost:9999/a", ["localhost:8790"]);
    no("http://localhost/a", ["localhost:8790"]);
    no("http://evil.example/a", ["https://user@localhost:8790/"]);
  });
});
