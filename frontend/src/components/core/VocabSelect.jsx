// ──────────────────────────────────────────────────────────────────────────────
// VocabSelect — MasterSelect for the module vocabularies, addressed by key.
//
//   <VocabSelect vocab="industries" value={form.industry}
//                onChange={v => setForm(f => ({ ...f, industry: v }))} />
//
// The point of the indirection is that a page should not have to know the
// endpoint, the singular label, or — the one that actually bites — which roles
// the backend accepts a POST from. MasterSelect hides its "+ Add new…" option
// for anyone outside `addRoles`; get that list wrong in a page file and the
// option is offered to someone whose POST comes back 403. So the registry is
// fetched from `GET /master/v`, which the same module serves from the same
// object the write routes enforce, and cached for the session.
//
// Until the registry resolves the picker renders a disabled placeholder rather
// than an empty <select>: an empty dropdown reads as "there is nothing to pick"
// and invites someone to type the value in somewhere else instead.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import api from '@/services/api/client';
import MasterSelect from './MasterSelect';

// One in-flight request for the whole app, resolved once and reused. Vocabulary
// definitions change when the code changes, not while a user is on a page.
let registryPromise = null;

export function loadVocabRegistry() {
  if (!registryPromise) {
    registryPromise = api.get('/master/v')
      .then(res => {
        const list = Array.isArray(res.data) ? res.data : [];
        return Object.fromEntries(list.map(v => [v.key, v]));
      })
      .catch(() => {
        // A failed fetch must not be cached as "no vocabularies exist" for the
        // rest of the session — the next picker to mount should try again.
        registryPromise = null;
        return {};
      });
  }
  return registryPromise;
}

/** Test seam: drop the cache so a suite can serve a different registry. */
export function __resetVocabRegistry() { registryPromise = null; }

/**
 * @param {string} vocab   registry key, e.g. 'expense-categories'
 * @param {string=} parent for a TWO-LEVEL vocabulary: the parent value the list
 *                  is scoped to, e.g. the expense type 'Travel'. Passing it
 *                  narrows the options AND is sent with a new value, because a
 *                  child created without one is a row no cascading picker will
 *                  ever show again — the API refuses it.
 */
export default function VocabSelect({ vocab, label, parent, ...rest }) {
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    let alive = true;
    loadVocabRegistry().then(reg => { if (alive) setEntry(reg[vocab] ?? null); });
    return () => { alive = false; };
  }, [vocab]);

  // ⚠ Both placeholder <select>s below carry the caller's `id` and an
  // aria-label. They did not, and a caller that writes
  // `<label htmlFor="x">` + `<VocabSelect id="x">` therefore had a label
  // pointing at nothing for as long as the registry fetch took — the element
  // with that id did not exist yet. A label that resolves only after a network
  // round trip is a label a screen reader may well read before it resolves.
  const placeholderProps = {
    id: rest.id,
    disabled: true,
    style: rest.selectStyle,
    'aria-label': rest.ariaLabel || label || vocab,
  };

  if (!entry) {
    return (
      <select {...placeholderProps} aria-busy="true">
        <option>{label ? `Loading ${label.toLowerCase()}…` : 'Loading…'}</option>
      </select>
    );
  }

  const twoLevel = Boolean(entry.parentOf);

  // A two-level picker with no parent chosen yet has nothing legitimate to
  // offer. Saying so beats an empty dropdown, which reads as "there is nothing
  // to pick" rather than "pick the other field first".
  if (twoLevel && !parent) {
    return (
      <select {...placeholderProps}>
        <option>{`Select ${(entry.parentLabel || 'a parent').toLowerCase()} first`}</option>
      </select>
    );
  }

  return (
    <MasterSelect
      // The parent is part of the endpoint, so changing it re-fetches: the
      // endpoint is MasterSelect's only load dependency, which is what makes
      // the cascade work without a second effect to keep in sync.
      endpoint={twoLevel ? `${entry.endpoint}?parent=${encodeURIComponent(parent)}` : entry.endpoint}
      label={label || entry.label}
      addRoles={entry.roles}
      // Sent with the POST so the new value lands under the right parent.
      createExtra={twoLevel ? { parent } : undefined}
      {...rest}
    />
  );
}
