/**
 * skills.js — workspace skill registry.
 *
 * A "skill" is a directory under <workspace>/skills/<name>/ that
 * contains a SKILL.md with YAML frontmatter (name + description) and
 * a markdown body. Optionally, references/*.md files alongside it
 * provide longer reference material loaded with the skill.
 *
 * The registry scans configured directories on init and exposes:
 *   - listSkills() — what's available
 *   - buildSkillsPrompt() — bootstrap context block describing skills
 *   - load(name) — load a skill's full content (body + references)
 *
 * Loading is lazy and on-demand: the bootstrap context advertises
 * skills (name + one-line description) but doesn't include their
 * bodies. The agent calls `use_skill` only when it needs one. This
 * keeps the bootstrap small while making capabilities discoverable.
 *
 * Multiple skill directories can be configured. The first dir's
 * versions win on name collision (so personal skills override
 * shared-library versions).
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { makeLogger } from './log.js';

const log = makeLogger('skills');

let skillDirs = [];
const registry = new Map();

/**
 * Initialize. Reads config.skills.dirs (array of paths, absolute or
 * workspace-relative). Default: ['skills'].
 *
 * Personal skills first, shared/team libraries second — first match
 * wins on name collision. Example multi-dir config for an agent that
 * pulls a shared skill library alongside its own:
 *
 *   skills: { dirs: ['skills', 'shared-skills/skills'] }
 */
function init(config) {
  const configured = config?.skills?.dirs || ['skills'];
  skillDirs = configured.map(p => isAbsolute(p) ? p : join(config.workspace, p));
  registry.clear();
}

function parseSkillMd(input) {
  const raw = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.startsWith('---')) return { error: 'no-frontmatter' };
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return { error: 'unterminated-frontmatter' };
  const frontmatter = raw.slice(3, endIdx).replace(/^\n/, '');
  const body = raw.slice(endIdx + 4).replace(/^\n/, '').trim();

  const fields = {};
  const lines = frontmatter.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) { i++; continue; }
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();

    // YAML block scalar: | preserves newlines, > folds them
    if (trimmed === '|' || trimmed === '>') {
      const joiner = trimmed === '>' ? ' ' : '\n';
      const blockLines = [];
      let indent = null;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim().length === 0) { blockLines.push(''); i++; continue; }
        const leading = next.match(/^(\s*)/)[1].length;
        if (indent === null) indent = leading;
        if (leading < indent) break;
        blockLines.push(next.slice(indent));
        i++;
      }
      fields[key] = blockLines.join(joiner).trim();
      continue;
    }

    // Quoted strings, possibly multi-line
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      const quote = trimmed[0];
      const closesOnSameLine = trimmed.length > 1 && trimmed.endsWith(quote);
      if (closesOnSameLine) {
        fields[key] = trimmed.slice(1, -1);
        i++;
        continue;
      }
      let acc = trimmed.slice(1);
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (next.endsWith(quote)) {
          acc += ' ' + next.slice(0, -1);
          i++;
          break;
        }
        acc += ' ' + next;
        i++;
      }
      fields[key] = acc.trim();
      continue;
    }

    fields[key] = trimmed;
    i++;
  }

  if (!fields.name) return { error: 'missing-name', fields };
  if (!fields.description) return { error: 'missing-description', fields };
  return { name: fields.name, description: fields.description, body };
}

async function scanOneDir(dir) {
  if (!existsSync(dir)) {
    log.debug(`No skills directory at ${dir}`);
    return { registered: 0, skipped: 0, shadowed: 0 };
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn(`Failed to read ${dir}`, err.message);
    return { registered: 0, skipped: 0, shadowed: 0 };
  }
  let registered = 0, skipped = 0, shadowed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    try {
      const raw = await readFile(skillMdPath, 'utf-8');
      const parsed = parseSkillMd(raw);
      if (parsed.error) {
        log.warn(`Skipped ${entry.name} in ${dir}: ${parsed.error}${parsed.fields ? ` (have: ${Object.keys(parsed.fields).join(',')})` : ''}`);
        skipped++;
        continue;
      }
      if (registry.has(parsed.name)) {
        log.debug(`Shadowed ${parsed.name} from ${dir} (already registered from ${registry.get(parsed.name).dir})`);
        shadowed++;
        continue;
      }
      registry.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        dir: join(dir, entry.name),
        loaded: false,
        body: parsed.body,
      });
      log.info(`Registered skill: ${parsed.name} (from ${dir})`);
      registered++;
    } catch (err) {
      log.warn(`Failed to parse skill ${entry.name} in ${dir}`, err.message);
    }
  }
  return { registered, skipped, shadowed };
}

async function scan() {
  registry.clear();
  let total = 0, totalShadowed = 0;
  for (const dir of skillDirs) {
    const { registered, shadowed } = await scanOneDir(dir);
    total += registered;
    totalShadowed += shadowed;
  }
  log.info(`${total} skill(s) registered across ${skillDirs.length} dir(s)${totalShadowed > 0 ? ` (${totalShadowed} shadowed by higher-priority dir)` : ''}`);
  return { total, shadowed: totalShadowed };
}

/**
 * Build the skills section of the bootstrap context. Lists name +
 * description for each registered skill, and tells the agent how to
 * call use_skill. Empty string if no skills registered.
 */
function buildSkillsPrompt() {
  if (registry.size === 0) return '';
  const lines = [
    '', '--- Available Skills ---',
    'You have skills that provide specialized knowledge. To use a skill, call:',
    '', '<tool_call>', '{"tool": "use_skill", "name": "skill-name"}', '</tool_call>',
    '', 'Skills:',
  ];
  for (const [name, skill] of registry) {
    lines.push(`- ${name}: ${skill.description}`);
  }
  lines.push('--- End Skills ---');
  return lines.join('\n');
}

/**
 * Load a skill by name. Returns the full body plus any reference
 * files in references/*.md. Marks the skill as loaded so subsequent
 * listSkills() calls show it.
 */
async function load(name) {
  const skill = registry.get(name);
  if (!skill) return `Unknown skill: ${name}. Available: ${[...registry.keys()].join(', ')}`;
  const sections = [`# Skill: ${skill.name}\n\n${skill.body}`];
  const refsDir = join(skill.dir, 'references');
  if (existsSync(refsDir)) {
    try {
      const refEntries = await readdir(refsDir);
      for (const ref of refEntries) {
        if (ref.endsWith('.md')) {
          const refContent = await readFile(join(refsDir, ref), 'utf-8');
          sections.push(`\n## Reference: ${ref}\n\n${refContent}`);
        }
      }
    } catch {}
  }
  skill.loaded = true;
  return sections.join('\n');
}

function listSkills() {
  return [...registry.entries()].map(([name, s]) => ({
    name, description: s.description, loaded: s.loaded,
  }));
}

export { init, scan, buildSkillsPrompt, load, listSkills, parseSkillMd };
