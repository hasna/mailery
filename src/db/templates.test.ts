import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  createTemplate,
  getTemplate,
  getTemplateByName,
  listTemplates,
  listTemplateSummaries,
  deleteTemplate,
  renderTemplate,
} from "./templates.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createTemplate", () => {
  it("creates a template with all fields", () => {
    const t = createTemplate({
      name: "welcome",
      subject_template: "Welcome {{name}}",
      html_template: "<h1>Hello {{name}}</h1>",
      text_template: "Hello {{name}}",
    });
    expect(t.id).toHaveLength(36);
    expect(t.name).toBe("welcome");
    expect(t.subject_template).toBe("Welcome {{name}}");
    expect(t.html_template).toBe("<h1>Hello {{name}}</h1>");
    expect(t.text_template).toBe("Hello {{name}}");
    expect(t.metadata).toEqual({});
  });

  it("creates a template with only subject", () => {
    const t = createTemplate({
      name: "simple",
      subject_template: "Hello",
    });
    expect(t.html_template).toBeNull();
    expect(t.text_template).toBeNull();
  });

  it("throws on duplicate name", () => {
    createTemplate({ name: "dup", subject_template: "Test" });
    expect(() => createTemplate({ name: "dup", subject_template: "Test2" })).toThrow();
  });
});

describe("getTemplate", () => {
  it("retrieves by id", () => {
    const t = createTemplate({ name: "byid", subject_template: "Test" });
    const found = getTemplate(t.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(t.id);
  });

  it("tolerates malformed metadata JSON", () => {
    const t = createTemplate({ name: "badmeta", subject_template: "Test" });
    getDatabase().run("UPDATE templates SET metadata = ? WHERE id = ?", ["not-json", t.id]);

    const found = getTemplate(t.id);
    expect(found?.metadata).toEqual({});
  });

  it("retrieves by name", () => {
    createTemplate({ name: "byname", subject_template: "Test" });
    const found = getTemplate("byname");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("byname");
  });

  it("returns null for unknown", () => {
    expect(getTemplate("nonexistent")).toBeNull();
  });
});

describe("getTemplateByName", () => {
  it("retrieves by name", () => {
    createTemplate({ name: "lookup", subject_template: "Test" });
    const found = getTemplateByName("lookup");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("lookup");
  });

  it("returns null for unknown name", () => {
    expect(getTemplateByName("nope")).toBeNull();
  });
});

describe("listTemplates", () => {
  it("returns empty array when no templates", () => {
    expect(listTemplates()).toEqual([]);
  });

  it("lists all templates", () => {
    createTemplate({ name: "a", subject_template: "A" });
    createTemplate({ name: "b", subject_template: "B" });
    const list = listTemplates();
    expect(list.length).toBe(2);
  });

  it("paginates templates after ordering newest first", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const template = createTemplate({ name: `page-${i}`, subject_template: `Subject ${i}` });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE templates SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, template.id]);
    }

    const page = listTemplates(undefined, { limit: 2, offset: 1 });

    expect(page.map((template) => template.name)).toEqual(["page-3", "page-2"]);
  });
});

describe("listTemplateSummaries", () => {
  it("uses a lean projection and omits template body columns", () => {
    const db = getDatabase();
    createTemplate({
      name: "large",
      subject_template: "Large {{name}}",
      html_template: `<main>${"large html body ".repeat(300)}</main>`,
      text_template: "large text body ".repeat(300),
    });
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) => {
            queries.push(sql);
            return target.query(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const [summary] = listTemplateSummaries(recordingDb, { limit: 1 });

    expect(summary).toBeDefined();
    expect(summary?.name).toBe("large");
    expect(summary?.has_html_template).toBe(true);
    expect(summary?.has_text_template).toBe(true);
    expect("html_template" in summary!).toBe(false);
    expect("text_template" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large html body");
    expect(JSON.stringify(summary)).not.toContain("large text body");
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).toContain("has_html_template");
    expect(queries[0]).toContain("has_text_template");
    expect(queries[0]).not.toMatch(/\bsubject_template,\s*html_template,\s*text_template\b/);
  });

  it("paginates summaries after ordering newest first", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const template = createTemplate({
        name: `summary-${i}`,
        subject_template: `Summary ${i}`,
        html_template: i % 2 === 0 ? "<p>html</p>" : undefined,
      });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE templates SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, template.id]);
    }

    const page = listTemplateSummaries(undefined, { limit: 2, offset: 1 });

    expect(page.map((template) => template.name)).toEqual(["summary-3", "summary-2"]);
    expect(page.map((template) => template.has_html_template)).toEqual([false, true]);
  });
});

describe("deleteTemplate", () => {
  it("deletes by name", () => {
    createTemplate({ name: "del", subject_template: "Test" });
    expect(deleteTemplate("del")).toBe(true);
    expect(getTemplate("del")).toBeNull();
  });

  it("deletes by id", () => {
    const t = createTemplate({ name: "delid", subject_template: "Test" });
    expect(deleteTemplate(t.id)).toBe(true);
    expect(getTemplate(t.id)).toBeNull();
  });

  it("returns false for unknown", () => {
    expect(deleteTemplate("nonexistent")).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("replaces single variable", () => {
    expect(renderTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("replaces multiple variables", () => {
    const result = renderTemplate("{{greeting}} {{name}}, your order #{{order}} is ready", {
      greeting: "Hi",
      name: "Alice",
      order: "12345",
    });
    expect(result).toBe("Hi Alice, your order #12345 is ready");
  });

  it("leaves unknown variables as-is", () => {
    expect(renderTemplate("Hello {{name}} {{unknown}}", { name: "World" })).toBe(
      "Hello World {{unknown}}",
    );
  });

  it("handles empty vars", () => {
    expect(renderTemplate("Hello {{name}}", {})).toBe("Hello {{name}}");
  });

  it("handles template with no variables", () => {
    expect(renderTemplate("No vars here", { name: "ignored" })).toBe("No vars here");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", { name: "World" })).toBe("");
  });
});
