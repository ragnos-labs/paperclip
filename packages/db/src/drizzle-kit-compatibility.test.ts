import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the TypeScript config and generates from compiled ESM schema without the legacy loader", () => {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("drizzle-kit")), "bin.cjs");
  expect(() => createRequire(cli).resolve("@esbuild-kit/esm-loader"))
    .toThrowError(expect.objectContaining({ code: "MODULE_NOT_FOUND" }));
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-drizzle-compatibility-"));
  try {
    mkdirSync(path.join(directory, "dist/schema"), { recursive: true });
    symlinkSync(path.join(packageDir, "node_modules"), path.join(directory, "node_modules"), "dir");
    writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(path.join(directory, "dist/schema/companies.js"), `
      import { pgTable, uuid, text } from "drizzle-orm/pg-core";
      export const companies = pgTable("companies", {
        id: uuid("id").defaultRandom().primaryKey(),
        name: text("name").notNull(),
      });
      export const issues = pgTable("issues", {
        id: uuid("id").primaryKey(),
        companyId: uuid("company_id").notNull().references(() => companies.id),
      });
    `);
    const generate = () => execFileSync(process.execPath, [cli, "generate", "--config", path.join(packageDir, "drizzle.config.ts")], {
      cwd: directory,
      env: { ...process.env, DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused" },
      encoding: "utf8",
      timeout: 20_000,
    });
    generate();
    const migrationsDir = path.join(directory, "src/migrations");
    const sqlFiles = () => readdirSync(migrationsDir).filter((file) => file.endsWith(".sql"));
    expect(sqlFiles()).toHaveLength(1);
    const sql = readFileSync(path.join(migrationsDir, sqlFiles()[0]!), "utf8");
    expect(sql).toContain('CREATE TABLE "companies"');
    expect(sql).toContain('CREATE TABLE "issues"');
    expect(sql).toContain('"name" text NOT NULL');
    expect(sql).toContain('REFERENCES "public"."companies"("id")');
    expect(generate()).toContain("No schema changes");
    expect(sqlFiles()).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
