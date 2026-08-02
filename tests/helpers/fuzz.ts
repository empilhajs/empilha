export type Fuzzer = {
  next(): number;
  integer(maxExclusive: number): number;
  token(length?: number): string;
};

/** Gerador determinístico pequeno para reproduzir qualquer caso fuzzado. */
export function createFuzzer(seed = 0xe1a11a): Fuzzer {
  let state = seed >>> 0;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_-";
  return {
    next(): number {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
    integer(maxExclusive: number): number {
      return Math.floor(this.next() * maxExclusive);
    },
    token(length = 8): string {
      return Array.from(
        { length },
        () => alphabet[this.integer(alphabet.length)],
      ).join("");
    },
  };
}
