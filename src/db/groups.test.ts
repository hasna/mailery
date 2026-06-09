import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  createGroup,
  getGroup,
  getGroupByName,
  listGroups,
  deleteGroup,
  addMember,
  removeMember,
  getMember,
  listMembers,
  listMemberSummaries,
  getMemberCount,
  getMemberCounts,
} from "./groups.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createGroup", () => {
  it("creates a group with name only", () => {
    const group = createGroup("newsletter");
    expect(group.id).toHaveLength(36);
    expect(group.name).toBe("newsletter");
    expect(group.description).toBeNull();
  });

  it("creates a group with description", () => {
    const group = createGroup("vip", "VIP customers");
    expect(group.name).toBe("vip");
    expect(group.description).toBe("VIP customers");
  });

  it("throws on duplicate name", () => {
    createGroup("test");
    expect(() => createGroup("test")).toThrow();
  });
});

describe("getGroup", () => {
  it("retrieves group by id", () => {
    const created = createGroup("test");
    const found = getGroup(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("test");
  });

  it("returns null for unknown id", () => {
    expect(getGroup("nonexistent")).toBeNull();
  });
});

describe("getGroupByName", () => {
  it("retrieves group by name", () => {
    createGroup("newsletter");
    const found = getGroupByName("newsletter");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("newsletter");
  });

  it("returns null for unknown name", () => {
    expect(getGroupByName("nonexistent")).toBeNull();
  });
});

describe("listGroups", () => {
  it("returns empty array when no groups", () => {
    expect(listGroups()).toEqual([]);
  });

  it("lists all groups ordered by name", () => {
    createGroup("beta");
    createGroup("alpha");
    const groups = listGroups();
    expect(groups.length).toBe(2);
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[1]!.name).toBe("beta");
  });

  it("paginates groups after sorting by name", () => {
    createGroup("gamma");
    createGroup("alpha");
    createGroup("delta");
    createGroup("beta");

    const groups = listGroups(undefined, { limit: 2, offset: 1 });

    expect(groups.map((group) => group.name)).toEqual(["beta", "delta"]);
  });
});

describe("deleteGroup", () => {
  it("deletes a group", () => {
    const group = createGroup("test");
    const result = deleteGroup(group.id);
    expect(result).toBe(true);
    expect(getGroup(group.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteGroup("nonexistent")).toBe(false);
  });

  it("cascades to delete members", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com");
    deleteGroup(group.id);
    // Members should be gone
    expect(listMembers(group.id)).toEqual([]);
  });
});

describe("addMember", () => {
  it("adds a member with email only", () => {
    const group = createGroup("test");
    const member = addMember(group.id, "alice@example.com");
    expect(member.group_id).toBe(group.id);
    expect(member.email).toBe("alice@example.com");
    expect(member.name).toBeNull();
    expect(member.vars).toEqual({});
  });

  it("adds a member with name and vars", () => {
    const group = createGroup("test");
    const member = addMember(group.id, "bob@example.com", "Bob", { company: "Acme" });
    expect(member.name).toBe("Bob");
    expect(member.vars).toEqual({ company: "Acme" });
  });

  it("replaces existing member on duplicate email", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com", "Alice");
    addMember(group.id, "alice@example.com", "Alice Updated");
    const members = listMembers(group.id);
    expect(members.length).toBe(1);
    expect(members[0]!.name).toBe("Alice Updated");
  });
});

describe("removeMember", () => {
  it("removes a member", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com");
    const result = removeMember(group.id, "alice@example.com");
    expect(result).toBe(true);
    expect(listMembers(group.id)).toEqual([]);
  });

  it("returns false for unknown member", () => {
    const group = createGroup("test");
    expect(removeMember(group.id, "unknown@example.com")).toBe(false);
  });
});

describe("listMembers", () => {
  it("returns empty array when no members", () => {
    const group = createGroup("test");
    expect(listMembers(group.id)).toEqual([]);
  });

  it("tolerates malformed member vars JSON", () => {
    const group = createGroup("test");
    addMember(group.id, "alice@example.com", "Alice", { role: "owner" });
    getDatabase().run("UPDATE group_members SET vars = ? WHERE group_id = ? AND email = ?", ["not-json", group.id, "alice@example.com"]);

    const members = listMembers(group.id);
    expect(members[0]?.vars).toEqual({});
  });

  it("lists all members ordered by email", () => {
    const group = createGroup("test");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com");
    const members = listMembers(group.id);
    expect(members.length).toBe(3);
    expect(members[0]!.email).toBe("alice@example.com");
    expect(members[1]!.email).toBe("bob@example.com");
    expect(members[2]!.email).toBe("charlie@example.com");
  });

  it("paginates members after sorting by email", () => {
    const group = createGroup("test");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com");

    const members = listMembers(group.id, undefined, { limit: 2, offset: 1 });

    expect(members.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
  });
});

describe("listMemberSummaries", () => {
  it("uses a lean projection and omits member vars", () => {
    const db = getDatabase();
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
    const group = createGroup("summary-test", undefined, db);
    addMember(group.id, "alice@example.com", "Alice", { notes: "large vars ".repeat(200) }, db);

    const [summary] = listMemberSummaries(group.id, recordingDb);

    expect(summary).toMatchObject({ group_id: group.id, email: "alice@example.com", name: "Alice" });
    expect("vars" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large vars");
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\bvars\b/);
  });

  it("paginates summaries after sorting by email", () => {
    const group = createGroup("summary-page");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com");

    const summaries = listMemberSummaries(group.id, undefined, { limit: 2, offset: 1 });

    expect(summaries.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
  });
});

describe("getMember", () => {
  it("returns a full member including vars", () => {
    const group = createGroup("detail-test");
    addMember(group.id, "alice@example.com", "Alice", { company: "Acme" });

    const member = getMember(group.id, "alice@example.com");

    expect(member).toMatchObject({
      group_id: group.id,
      email: "alice@example.com",
      vars: { company: "Acme" },
    });
    expect(getMember(group.id, "missing@example.com")).toBeNull();
  });
});

describe("getMemberCount", () => {
  it("returns 0 for empty group", () => {
    const group = createGroup("test");
    expect(getMemberCount(group.id)).toBe(0);
  });

  it("returns correct count", () => {
    const group = createGroup("test");
    addMember(group.id, "a@example.com");
    addMember(group.id, "b@example.com");
    addMember(group.id, "c@example.com");
    expect(getMemberCount(group.id)).toBe(3);
  });

  it("returns batched member counts for selected groups", () => {
    const first = createGroup("first");
    const second = createGroup("second");
    const empty = createGroup("empty");
    addMember(first.id, "a@example.com");
    addMember(first.id, "b@example.com");
    addMember(second.id, "c@example.com");

    const counts = getMemberCounts([first.id, second.id, empty.id]);

    expect(counts.get(first.id)).toBe(2);
    expect(counts.get(second.id)).toBe(1);
    expect(counts.get(empty.id)).toBe(0);
  });
});
