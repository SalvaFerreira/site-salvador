// The profile as Markdown, for AI agents and tools that read text: the same
// content as the Profile page, built from the same files.
import { byOrganisation, CV_PATH, getContact, getPlaces, getProfile, hasCv, orgOf, pathOf, SITE_NAME, type Entry } from "./places";

/** A content file's Markdown without its editing notes. */
const bodyOf = (e: Entry) =>
  (e.body ?? "")
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    // Headings inside an entry sit under the entry's own heading.
    .replace(/^(#+) /gm, (_, h: string) => `${"#".repeat(Math.min(6, h.length + 2))} `)
    .trim();
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export async function buildProfileMarkdown(site: URL): Promise<string> {
  const [places, profile, contact] = await Promise.all([getPlaces(), getProfile(), getContact()]);
  const abs = (path: string) => new URL(path, site).href;
  const out: string[] = [];

  out.push(`# ${SITE_NAME}`, "", `**${profile.role}** · Lisbon, Portugal`, "", profile.headline, "");
  const links = [
    hasCv && `[CV (PDF)](${abs(CV_PATH)})`,
    contact.email && `Email: ${contact.email.replace(/^mailto:/, "")}`,
    contact.linkedin && `[LinkedIn](${contact.linkedin})`,
    profile.github && `[GitHub](${profile.github})`,
    `[Website](${abs("/")})`,
  ].filter(Boolean);
  out.push(links.join(" · "), "");

  out.push("## Strengths", "");
  profile.strengths.forEach((s, i) => out.push(`${i + 1}. **${s.title}.** ${s.proof}`));
  out.push("");

  out.push("## Skills and tools", "");
  for (const g of profile.skills) out.push(`- **${g.group}:** ${g.items.join(", ")}`);
  out.push(`- **Spoken languages:** ${profile.languages.map((l) => `${l.name} (${l.level})`).join(", ")}`, "");

  const section = (title: string, category: "job" | "education" | "personal") => {
    out.push(`## ${title}`, "");
    for (const { org, entries } of byOrganisation(places, category)) {
      const first = entries[0].data;
      out.push(`### ${category === "job" ? org : first.title}`, "");
      const meta = [first.role, first.period, category === "job" ? first.place : undefined].filter(Boolean).join(" · ");
      if (meta) out.push(`*${meta}* · [details](${abs(pathOf(entries[0]))})`, "");
      for (const e of entries) {
        if (entries.length > 1) out.push(`#### ${capital(e.data.title.replace(`${orgOf(e)}: `, ""))}`, "");
        if (e.data.summary) out.push(`**${e.data.summary}**`, "");
        if (e.data.stack.length) out.push(`Stack: ${e.data.stack.join(", ")}`, "");
        const body = bodyOf(e);
        if (body) out.push(body, "");
        if (category === "personal" && e.data.links.length) {
          out.push(e.data.links.map((l) => `[${l.label}](${l.url})`).join(" · "), "");
        }
      }
    }
  };
  section("Experience", "job");
  section("Education", "education");
  section("Projects", "personal");

  const now = places.find((e) => e.data.kind === "now");
  if (now) out.push(`## ${now.data.title}`, "", bodyOf(now), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** llms.txt: a short index of the site for AI agents (llmstxt.org). */
export async function buildLlmsTxt(site: URL): Promise<string> {
  const [places, profile] = await Promise.all([getPlaces(), getProfile()]);
  const abs = (path: string) => new URL(path, site).href;
  const line = (e: Entry) => `- [${e.data.title}](${abs(pathOf(e))}): ${[e.data.role, e.data.period].filter(Boolean).join(", ")}`;
  const of = (category: string) => places.filter((e) => e.data.category === category && e.data.kind === "work").map(line);
  return [
    `# ${SITE_NAME}`,
    "",
    `> ${profile.role} based in Lisbon, Portugal. ${profile.headline} The full profile (strengths, skills, experience, education, projects) is at ${abs("/profile.md")}.`,
    "",
    "## Profile",
    "",
    `- [For AI agents](${abs("/agents")}): the facts in a fixed shape, and where everything is as text and data`,
    `- [Profile in Markdown](${abs("/profile.md")}): everything on this site as text`,
    `- [Profile as JSON-LD](${abs("/profile.json")}): schema.org data (ProfilePage about a Person)`,
    `- [Profile page](${abs("/profile")})`,
    ...(hasCv ? [`- [CV (PDF)](${abs(CV_PATH)})`] : []),
    "",
    "## Experience",
    "",
    ...of("job"),
    "",
    "## Education",
    "",
    ...of("education"),
    "",
    "## Projects",
    "",
    ...of("personal"),
    "",
  ].join("\n");
}
