import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createGroup, getGroupByName, listGroups, deleteGroup, addMember, removeMember, listMemberSummaries, getMemberCount, getMemberCounts } from "../../db/groups.js";
import { confirmDestructiveAction, handleError, parseCliPage } from "../utils.js";

export function registerGroupCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const groupCmd = program.command("group").description("Manage recipient groups");

  groupCmd
    .command("create <name>")
    .description("Create a recipient group")
    .option("--description <text>", "Group description")
    .action((name: string, opts: { description?: string }) => {
      try {
        const group = createGroup(name, opts.description);
        console.log(chalk.green(`✓ Group created: ${group.name} (${group.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("list")
    .description("List recipient groups")
    .option("--limit <n>", "Maximum groups to show", "50")
    .option("--offset <n>", "Number of groups to skip", "0")
    .action((opts: { limit?: string; offset?: string }) => {
      try {
        const page = parseCliPage(opts);
        const groups = listGroups(undefined, page);
        if (groups.length === 0) {
          output([], chalk.dim("No groups configured. Use 'emails group create' to add one."));
          return;
        }
        const counts = getMemberCounts(groups.map((group) => group.id));
        const result = groups.map((group) => ({
          ...group,
          member_count: counts.get(group.id) ?? 0,
        }));
        const lines: string[] = [chalk.bold("\nGroups:")];
        for (const g of groups) {
          const count = counts.get(g.id) ?? 0;
          const desc = g.description ? chalk.dim(` — ${g.description}`) : "";
          lines.push(`  ${chalk.cyan(g.id.slice(0, 8))}  ${g.name}  (${count} members)${desc}`);
        }
        lines.push("");
        output(result, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("show <name>")
    .description("Show group details and members")
    .option("--limit <n>", "Maximum members to show", "50")
    .option("--offset <n>", "Number of members to skip", "0")
    .action((name: string, opts: { limit?: string; offset?: string }) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        const page = parseCliPage(opts);
        const members = listMemberSummaries(group!.id, undefined, page);
        const memberCount = getMemberCount(group!.id);
        const lines: string[] = [chalk.bold(`\nGroup: ${group!.name}`)];
        if (group!.description) lines.push(chalk.dim(`  ${group!.description}`));
        lines.push(`  Members (${members.length} shown / ${memberCount} total):`);
        if (members.length === 0) {
          lines.push(chalk.dim("    No members. Use 'emails group add' to add some."));
        } else {
          for (const m of members) {
            const displayName = m.name ? ` (${m.name})` : "";
            lines.push(`    ${m.email}${displayName}`);
          }
        }
        lines.push("");
        output({ group, members, member_count: memberCount }, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("members <name>")
    .description("List members in a recipient group")
    .option("--limit <n>", "Maximum members to show", "50")
    .option("--offset <n>", "Number of members to skip", "0")
    .action((name: string, opts: { limit?: string; offset?: string }) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        const page = parseCliPage(opts);
        const members = listMemberSummaries(group!.id, undefined, page);
        if (members.length === 0) {
          output([], chalk.dim("No members."));
          return;
        }
        const lines: string[] = [chalk.bold(`\nMembers for '${group!.name}':`)];
        for (const m of members) {
          const displayName = m.name ? ` (${m.name})` : "";
          lines.push(`  ${m.email}${displayName}`);
        }
        lines.push("");
        output(members, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("add <name> <emails...>")
    .description("Add members to a group")
    .option("--name <displayName>", "Display name for the member(s)")
    .action((name: string, emails: string[], opts: { name?: string }) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        for (const email of emails) {
          addMember(group!.id, email, opts.name);
        }
        console.log(chalk.green(`✓ Added ${emails.length} member(s) to group '${name}'`));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("remove-member <name> <email>")
    .description("Remove a member from a group")
    .action((name: string, email: string) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        const removed = removeMember(group!.id, email);
        if (!removed) handleError(new Error(`Member not found: ${email}`));
        console.log(chalk.green(`✓ Removed ${email} from group '${name}'`));
      } catch (e) {
        handleError(e);
      }
    });

  groupCmd
    .command("delete <name>")
    .description("Delete a group")
    .option("--yes", "Skip confirmation prompt")
    .action(async (name: string, opts: { yes?: boolean }) => {
      try {
        const group = getGroupByName(name);
        if (!group) handleError(new Error(`Group not found: ${name}`));
        await confirmDestructiveAction(`Delete group ${name}?`, opts.yes);
        deleteGroup(group.id);
        console.log(chalk.green(`✓ Group deleted: ${name}`));
      } catch (e) {
        handleError(e);
      }
    });
}
