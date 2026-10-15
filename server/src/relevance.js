import { createHash } from 'node:crypto';
import { canReply } from './mail.js';

export const DEFAULT_QUERY = 'in:inbox newer_than:7d';
export const LEGACY_QUERY = 'in:inbox newer_than:7d -category:promotions -category:social';
export function jobProfile(data) {
  return data.preferences?.jobProfile?.trim() || '';
}
export function relevanceKey(profile) {
  return createHash('sha256').update(`jobs-and-direct-v1:${profile}`).digest('hex');
}
export function applyRelevance(analysis, email, account, profile) {
  const direct = analysis.category === 'direct' && canReply(email, account);
  const matchedJob = analysis.category === 'job' && !!profile && analysis.jobMatch === 'strong';
  const important = direct || matchedJob;
  const needsReply = important && analysis.needsReply && canReply(email, account);
  return { ...analysis, important, needsReply, draft: needsReply ? analysis.draft : '' };
}
