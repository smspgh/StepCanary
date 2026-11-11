// The four platform onboarding guides, served from the app so customers can reach them.
// Source of truth: docs/guides/*.md (see scripts/build-guides.mjs).

import { renderMarkdown, titleOf } from '../core/markdown';
import { GUIDE_MARKDOWN, TEMPLATE_FILES } from './guides-content';

export interface GuideInfo {
  slug: string;
  platform: string;
  summary: string;
  /** Set when the platform is being retired: shown apart from the current platforms. */
  closing?: string;
}

export const GUIDES: GuideInfo[] = [
  { slug: 'zapier', platform: 'Zapier', summary: 'Add a “Webhooks by Zapier” POST step to the end of a Zap.' },
  { slug: 'make', platform: 'Make', summary: 'Add an HTTP “Make a request” module to the end of a scenario.' },
  { slug: 'n8n', platform: 'n8n', summary: 'Add an HTTP Request node to the end of a workflow.' },
  {
    slug: 'pipedream',
    platform: 'Pipedream',
    summary: 'Add a Node.js code step to the end of a workflow.',
    closing: 'Pipedream Workflows shuts down on March 31, 2027, and no longer accepts new signups.',
  },
];

/** "What is a check?": the concept page every other page links to for a definition. */
export const CONCEPT_SLUG = 'checks';

const DOC_HOST = 'https://ping.stepcanary.com';

/**
 * Render a guide. `pingBase` is this deployment's ping hostname; with `token` (a signed-in
 * user's own check) every example URL becomes that check's real ping URL, ready to copy.
 */
export function renderGuide(slug: string, pingBase: string, token?: string, checkId?: string): { title: string; html: string } | null {
  const source = GUIDE_MARKDOWN[slug];
  if (!source) return null;
  const base = pingBase.replace(/\/$/, '');
  let md = source.split(DOC_HOST).join(base);
  if (token) {
    md = md
      .split('…/p/your-token').join(`${base}/p/${token}`)
      .split('/p/YOUR-TOKEN').join(`/p/${token}`)
      .split('/p/your-token').join(`/p/${token}`)
      .split(`${base}/p/…`).join(`${base}/p/${token}`);
  }
  // Template downloads opened from a check carry that check along, so the file comes pre-filled.
  if (token && checkId) md = md.split('.json)').join(`.json?check=${encodeURIComponent(checkId)})`);
  return { title: titleOf(md), html: renderMarkdown(md) };
}

/**
 * An importable template file (currently n8n workflows), with this deployment's ping hostname
 * and, when known, the customer's real ping URL in place of the placeholder.
 */
export function renderTemplate(path: string, pingBase: string, token?: string): string | null {
  const source = TEMPLATE_FILES[path];
  if (!source) return null;
  const base = pingBase.replace(/\/$/, '');
  const out = source.split(DOC_HOST).join(base);
  return token ? out.split('/p/YOUR-TOKEN').join(`/p/${token}`) : out;
}
