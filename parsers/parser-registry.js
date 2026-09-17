// Registry of credit card statement parsers.
//
// Adding a provider means adding one file that calls
// StatementParsers.register(...). No database, analytics or UI code changes.
//
// Parser contract:
//   id           string   unique key used by the manual override dropdown
//   providerCode string   must match credit_card_providers.code
//   label        string   shown in the UI
//   detect(text) number   confidence 0..1 that this parser owns the document
//   parse(text)  object   { statement: {...}, transactions: [...], warnings: [] }
//
// parse() must be a pure function of the extracted text: same PDF in, same
// rows out, including duplicate_sequence.

window.StatementParsers = (() => {
  const parsers = [];

  function register(parser) {
    const required = ["id", "providerCode", "label", "detect", "parse"];
    const missing = required.filter(key => !parser || parser[key] == null);

    if (missing.length) {
      throw new Error(`Invalid statement parser, missing: ${missing.join(", ")}`);
    }

    if (parsers.some(existing => existing.id === parser.id)) {
      throw new Error(`Statement parser already registered: ${parser.id}`);
    }

    parsers.push(parser);
  }

  function list() {
    return parsers.slice();
  }

  function get(id) {
    return parsers.find(parser => parser.id === id) || null;
  }

  // Returns every parser with its confidence, best first.
  function rank(text) {
    return parsers
      .map(parser => {
        let score = 0;

        try {
          score = Number(parser.detect(text)) || 0;
        } catch (error) {
          console.warn(`Parser ${parser.id} failed during detection`, error);
        }

        return { parser, score: Math.max(0, Math.min(1, score)) };
      })
      .sort((a, b) => b.score - a.score);
  }

  function detect(text, minimumScore = 0.4) {
    const ranked = rank(text);
    const best = ranked[0];

    return best && best.score >= minimumScore ? best : null;
  }

  return { register, list, get, rank, detect };
})();
