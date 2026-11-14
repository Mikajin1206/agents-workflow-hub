import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstuvwxyz';

/** 按时间可排序的短 id：<前缀>_<36进制毫秒>_<6位随机> */
export function newId(prefix = '') {
  const ts = Date.now().toString(36);
  let rand = '';
  const bytes = randomBytes(6);
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}${prefix ? '_' : ''}${ts}_${rand}`;
}

export const newEventId = () => newId('evt');
export const newTaskId = () => newId('tsk');
export const newApprovalId = () => newId('apr');
export const newLeaseId = () => newId('ls');
export const newRunId = () => newId('run');
export const newReportId = () => newId('rep');
export const newNotificationId = () => newId('ntf');
export const newDecisionId = () => newId('dec');
export const newPipelineId = () => newId('pl');

export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}
