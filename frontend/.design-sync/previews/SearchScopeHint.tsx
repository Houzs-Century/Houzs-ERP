import { SearchScopeHint } from "autocount-sync-frontend";

// One-line footnote under a list's search field saying HOW FAR the search
// reaches (all pages server-side vs the loaded rows only) plus a live
// match/record count once the query settles.

export const ServerScope = () => (
  <SearchScopeHint scope="server" resultCount={795} />
);

export const LoadedCapped = () => (
  <SearchScopeHint scope="loaded" loadedLimit={500} resultCount={37} term="luna" />
);

export const WhileSearching = () => (
  <SearchScopeHint scope="server" searching resultCount={795} term="marble" />
);
