// Which async answer a screen may still use. Each request takes a ticket for
// the key it was made for (the kid and routine a sheet is open for). reset()
// starts over with a new key: the sheet closed, opened again or switched
// kids. A newer ticket, a reset or another key makes an older ticket stale,
// and its answer is dropped. Client-safe and pure, so it is tested on its own.

export type AnswerTicket = { readonly seq: number; readonly key: string };

export type AnswerGate = {
  /** Start over for `key`: every ticket handed out so far is stale. */
  reset: (key: string) => void;
  /** A ticket for a request made for `key`; stale from the start unless `key` is the current one. */
  take: (key: string) => AnswerTicket;
  /** Whether the answer to `ticket` may still be used. */
  isCurrent: (ticket: AnswerTicket) => boolean;
};

export function answerGate(): AnswerGate {
  let seq = 0;
  let current = "";
  return {
    reset: (key) => {
      current = key;
      seq++;
    },
    // A request for another key (a stale closure) must not make the current
    // request's ticket stale, so it does not count.
    take: (key) => (key === current ? { seq: ++seq, key } : { seq: -1, key }),
    isCurrent: (ticket) => ticket.seq === seq && ticket.key === current,
  };
}
