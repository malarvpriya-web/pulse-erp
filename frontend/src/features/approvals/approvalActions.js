import api from '@/services/api/client';

/**
 * Runs an action descriptor returned by GET /approvals/pending (or
 * /approvals/my-requests). The descriptor names the ORIGINATING MODULE's own
 * endpoint — e.g. POST /leaves/approve/manager/12, PUT /travel/requests/9/status
 * — so a decision taken in the Approval Center goes through exactly the rules,
 * levels and side effects (leave balance, attendance sync, PR amount bands…)
 * that the module applies on its own screen. Never build these URLs here.
 *
 * @param {{method:string,url:string,body?:object,commentKey?:string,delegateKey?:string}} action
 * @param {{comment?:string, delegateId?:number|string}} [input]
 */
export function runApprovalAction(action, { comment, delegateId } = {}) {
  if (!action?.url || !action?.method) return Promise.reject(new Error('This action is not available.'));
  const body = { ...(action.body || {}) };
  if (action.commentKey && comment) body[action.commentKey] = comment;
  if (action.delegateKey && delegateId != null) {
    body[action.delegateKey] = action.delegateKey === 'delegate_to_user_id' ? Number(delegateId) : delegateId;
  }
  const method = String(action.method).toLowerCase();
  return api[method](action.url, body);
}

/** The server's own explanation, so a refusal reads as what it is (not "try again"). */
export function actionError(err, fallback = 'The action failed.') {
  const d = err?.response?.data;
  return d?.message || d?.error || err?.message || fallback;
}
