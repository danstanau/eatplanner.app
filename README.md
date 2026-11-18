# eatplanner.app

A personal weekly meal planner with a JSON recipe collection, food photography,
editable dinner plans, combined shopping lists and Copilot-powered recipe-photo
transcription.

## Run locally

Requires Node.js **26** and npm. If you use nvm, run `nvm use` to select the project's Node version.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:3000**. Browsing, planning, swapping, shopping lists,
manual recipe entry and sharing all work **without an AI subscription or API key**.

To read recipe photos, install the Copilot CLI if needed and sign in:

```sh
npm install -g @github/copilot
copilot login
```

If the server cannot see your CLI login, create a
[fine-grained GitHub personal access token](https://github.com/settings/personal-access-tokens/new)
owned by your personal account with the **Copilot Requests** account permission.
Set `COPILOT_GITHUB_TOKEN` in the server environment or in the git-ignored `.env`
file at the project root (use `.env.example` as a template), then restart the app.
This takes precedence over CLI login. A classic token will not work, and the
account still needs Copilot access.

Photo imports and photo search use the authenticated account's Copilot allowance.
The SDK runs on the server with tools and skills disabled. Credentials never go
to the browser. If `auto` doesn't select a vision-capable model for imports or
photo search, set
`COPILOT_VISION_MODEL` to one available on your account and restart the server.
`COPILOT_MODEL`, `PORT` and `COPILOT_CLI_PATH` are also optional configuration.

## The weekly flow

1. **Pick a week.** Weeks start on Monday. Open an existing week or choose any
   date to jump to its week.
2. **Choose cooking nights.** Toggle individual days, or quick-pick 3, 5 or 7
   dinners. Set household size, diet and total preparation/cooking time.
3. **Set your house rules.** Require a different primary protein for every
   dinner and optionally favour overlapping fresh ingredients. Protein groups
   are chicken, beef, pork, fish, tofu, legumes, eggs and cheese.
4. **Make the draft yours.** Swap a recipe for a matching alternative, choose
   “Surprise me”, or move a dinner to another day. Moving onto an occupied day
   exchanges the two meals. Drafts are saved after every change.
5. **Confirm.** This locks the week and saves a shopping list with ingredient
   quantities scaled to your household. Explicitly unlock it to edit; confirm
   again to rebuild the list.
6. **Shop and cook.** Copy the plain, one-ingredient-per-line list or tick items
   off. Open a recipe for ingredient checkboxes and large, step-by-step cooking
   instructions. Step progress is remembered in that browser.
7. **Share.** Each planned week can produce a PNG card. Use native file sharing
   where supported, or download the PNG and send it yourself. Draft cards are
   labelled as drafts. This is a snapshot, not a live collaborative link.

### How selection works

Planning selects from your saved recipes, without calling an AI model.
Diet, cooking-time limits, no duplicate recipes, and optional no-repeat proteins
are hard constraints. If there are too few matches, the app explains which rules
to relax instead of silently ignoring them. For example, the starter collection
has two vegan protein groups; a vegan plan with three dinners requires turning
off the different-proteins rule.

Ingredient overlap is a preference, not a guarantee or a globally optimal
shopping-cost calculation. After selecting a first recipe, subsequent choices
favour ingredients shared with earlier meals. Pantry staples don't influence this
score. Equal scores are randomised.

### Woolworths

“Copy shopping list” copies plain lines such as:

```text
800 g chicken thigh
2 lemon
60 ml olive oil
```

Paste them into a Woolworths shopping list wherever your app version supports
pasting. Check product matches, pack sizes and quantities yourself. **There is no
direct cart integration** and the app does not collect Woolworths credentials.
It does not scrape or automate private supermarket endpoints.

## Recipes and photo imports

The starter library includes **80 household meal cards** with generated draft
ingredients, steps, categories, primary protein, diet, servings, prep/cooking
times, notes and locally served food photography.

Use **Add recipe** to type a recipe manually or take/select a photo of its
ingredients and method. The browser resizes the photo, then sends it to Copilot
only when you press **Read recipe with Copilot**. The transcription fills an
editable form and reports ambiguities. Nothing enters your library until you
review the details, tick the review checkbox and save.

When editing a recipe, choose **Find a photo with Copilot** to turn its details
into a search phrase and look for a matching CC0 photo in Openverse, falling back
to Wikimedia Commons if Openverse is unavailable or has no suitable photo. The photo
appears in the editor for review and is saved only when you update the recipe;
its creator and licence are shown with the recipe. This sends recipe details to
Copilot and the photo sources. A broader dish-name search is tried if the first
search has no match or its photo is unavailable or rejected. The sources'
anonymous search allowances apply; no separate photo API key is needed.
Copilot visually checks up to five candidate photos before returning one: it must
show the prepared dish with no people, including hands or arms. Rejected photos
are skipped; if none is suitable, the current recipe image is left unchanged.
These checks use a vision-capable model and additional Copilot allowance.

Ingredient editor format:

```text
400 | g | canned chickpeas
1 | piece | lemon
1 | tbsp | olive oil | pantry
```

Supported units: `g`, `kg`, `ml`, `l`, `tsp`, `tbsp`, `piece`, `pinch`. Use
consistent, singular grocery names: identical names and compatible units are
combined, but the app does not guess whether different names are synonyms.
Mass and volume are not interchangeable. Australian tablespoons use **20 ml**
and teaspoons use **5 ml**. Review recipes from countries using 15 ml tablespoons;
store those amounts in `ml` to preserve the original quantities.

Photos are **serving inspiration**, not an exact depiction of every dish.
For imported recipes, the selected photo is stored with the saved card.
Open any recipe and choose **Edit recipe / update from photo** to transcribe a
source recipe into that existing card instead of creating a duplicate. Starter
recipes are drafts inferred from meal names, not verified family recipes;
compare generated details with the source before cooking.
Only import material you have permission to use. Check all AI-transcribed
amounts, dietary labels and instructions yourself.

## Files and persistence

```text
data/recipes.json    Starter recipe collection; edit to customise a fresh install
data/household.json  Your recipes, draft weeks and confirmed snapshots (gitignored)
public/             HTML, CSS, browser modules and local food photographs
server/recipes.ts   Recipe, photo and extraction schemas
server/planner.ts   Planning rules, alternatives, day moves and shopping aggregation
server/store.ts     Serialized, atomic JSON persistence
server/app.ts       Validated local HTTP API and static assets
server/copilot.ts   Server-only Copilot SDK integration
server/index.ts     Loopback server and shutdown
```

On the first write, the household file is seeded from `data/recipes.json`.
Later changes to the seed do not overwrite your household's recipes. Back up
`data/household.json` to preserve your collection and all weeks. Corrupt or
unwritable storage is reported as an error, never silently replaced.

Confirmed weeks contain recipe snapshots and their shopping quantities, so
future additions to the collection don't alter a locked plan. Revision checks
prevent stale tabs overwriting newer edits. If prompted, use **Refresh** on the
week before editing again.

Shopping checkmarks and cooking progress live in the current browser's
`localStorage`; the actual recipes and weeks are saved on the server. Clearing
site data removes those checkmarks, not your saved plans. The previous starter
app's generated browser-only plan is not automatically converted to a dated
week; its old localStorage entry is left untouched.

Run **one server process per household file**. Atomic writes protect against
partial files and requests within that process are serialized; this is not a
multi-process database.

## Commands

```sh
npm run dev     # Watch the server
npm run check   # Type-check server
npm test       # Rule, HTTP, storage and UI tests; no paid AI calls
npm run build  # Compile server into dist/
npm start      # Run compiled server; keep public/ and data/ alongside dist/
```

## Privacy and limits

- The server binds to loopback only. This is a personal local app, **not an
  authenticated public service**. Do not expose it through a public proxy or
  change the binding without adding access control, TLS and spending controls.
- Access from another phone/computer is not configured. Camera capture and
  native sharing depend on device/browser support. File upload, editable recipe
  entry and PNG download are the alternatives.
- Only photo transcription and the retained original AI generation API make
  model calls. Photos and their contents are sent to GitHub Copilot and its model
  provider. Copilot may retain local session data in its normal data directory.
- Monitor your Copilot allowance and configure additional-usage controls on
  GitHub. This app does not enforce a monetary spending cap. One photo task
  (extraction or search) runs at a time; failed requests can still consume
  credits.
- Always independently check allergens, ingredient labels and food-safety
  guidance. Dietary categories and cooking times are not medical or safety
  guarantees. Shopping quantities are requirements, not rounded product packs.

## Photography

Bundled photos are downloaded from Unsplash and served locally. Normal browsing
does not make third-party image requests; using the photo-search button sends a
search to Openverse and downloads the chosen CC0 image on the server. See the
[Unsplash licence](https://unsplash.com/license).

| Local photo | Source |
| --- | --- |
| Chicken | [Unsplash photo](https://images.unsplash.com/photo-1532550907401-a500c9a57435) |
| Beef | [Unsplash photo](https://images.unsplash.com/photo-1546833999-b9f581a1996d) |
| Salmon | [Unsplash photo](https://images.unsplash.com/photo-1510130387422-82bed34b37e9) |
| Pasta | [Unsplash photo](https://images.unsplash.com/photo-1473093295043-cdd812d0e601) |
| Salad | [Unsplash photo](https://images.unsplash.com/photo-1512621776951-a57141f2eefd) |
| Curry | [Unsplash photo](https://images.unsplash.com/photo-1603894584373-5ac82b2ae398) |
| Eggs | [Unsplash photo](https://images.unsplash.com/photo-1525351484163-7529414344d8) |
| Vegetables | [Unsplash photo](https://images.unsplash.com/photo-1540420773420-3366772f4999) |
