# eatplanner.app

A personal weekly meal planner with a JSON recipe collection, food photography,
editable dinner plans, combined shopping lists and Copilot-powered recipe-photo
transcription.

## Run locally

Requires Node.js **26** and npm. If you use nvm, run `nvm use` to select the project's Node version.

```sh
npm install
npm run auth:setup
npm run dev
```

During setup, accept `stanfield` as the super admin name, enter
`http://127.0.0.1:3000` as the app URL, and choose a password.
Open **http://127.0.0.1:3000** and sign in. Browsing, planning, swapping, shopping lists,
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
To prefer Unsplash for photo search, create an API app at
[Unsplash Developers](https://unsplash.com/developers), then set
`UNSPLASH_ACCESS_KEY` in the server environment or git-ignored `.env` file.
The key stays on the server. Without it, photo search uses Openverse and
Wikimedia Commons.

## Super admin, households and hosting

The login configured in `.env` is the **super admin**. It can use the planner
and add recipes normally, and can manage additional households through the
**Admin** gear button. Existing recipes and plans stay with this account.
There is no public sign-up. No external authentication service is needed.
To configure the super admin login, run:

```sh
npm run auth:setup
```

Accept `stanfield` as the super admin name (or choose another name), enter the URL
you will use to access the app, and choose a password of at least 6 characters.
Short, simple passwords are easier to guess, especially on a public site. Share the
super admin password only with people who should manage all household logins.
Password entry is hidden. The command saves the name,
a randomly salted scrypt password hash, and `APP_ORIGIN` in the gitignored
`.env` file; it never saves the plaintext password. Restart the server after
setup. Use the same command to change credentials; restarting also signs out
existing sessions.

In **Admin**, add a household with a unique name and a password of at least
6 characters. Share that login with its members. Names are case-insensitive.
All households share the same read-only starter recipe library. By default, the
collection and meal planner use starter recipes plus the current household's additions.
Use **Recipe source** in either place to use just your household's recipes,
other households' additions, or all recipes. Swaps follow the week's saved choice.
Added recipes are visible to other signed-in households but editable only by the
household that added them. Plans and shopping lists stay private. The main
household uses ID `1`; older additions are attributed to the household that saved them.
Only the super admin can list households, change their names or reset passwords.
A name change preserves household data and active sessions; a password reset
signs out that household's existing sessions immediately. Passwords cannot be
viewed or recovered. Super admin credentials are managed only through `.env`.
All households' AI features currently use the server's configured Copilot account.

The planner, recipes, local photos and all planning/photo/AI APIs require login
at all times. **Sign out** ends the current browser session. Sessions expire
after seven days, are kept only in server memory, and end when the server
restarts. Use one server process; no session database is required. Cookies are
HTTP-only and SameSite=Strict, with Secure cookies for HTTPS. Login attempts are
limited to ten per 15 minutes per connecting IP address (including successful
logins). Behind a reverse proxy this limit is shared by clients of that proxy;
the app deliberately does not trust forwarded IP headers.

For hosting, put a TLS reverse proxy in front of the Node server and configure:

```dotenv
NODE_ENV=production
APP_ORIGIN=https://meals.example.com
ALLOW_NETWORK_ACCESS=true
```

`HOUSEHOLD_USERNAME` and `HOUSEHOLD_PASSWORD_HASH` are supplied by the setup
command. Server startup fails if any login setting is missing or the hash is
invalid. Public URLs must use HTTPS, even if `NODE_ENV` is not set. `npm run build`
builds the Vite/React/Mantine client into `public/build/` and compiles the Express
server into `dist/`; `npm start` serves both. Keep Node bound to loopback when the proxy is on the same host;
set `HOST=0.0.0.0` only when your hosting platform requires it, and prevent direct
public access to Node's HTTP port. The proxy should preserve the original
request path and must not cache app responses. `APP_ORIGIN` is the canonical
browser origin used for same-origin checks, so TLS termination needs no
`trust proxy` setting.

The client uses a per-response nonce for injected style blocks. Mantine also
sets CSS custom properties on its controls, so the CSP separately permits
inline style attributes with `style-src-attr`; scripts and style blocks remain
restricted to self-hosted files and the response nonce.

HTTP is allowed only for loopback development addresses; phone testing on your
LAN also requires HTTPS. `NODE_ENV=production` requires HTTPS for all addresses.
For local HTTP development, visiting sign-in through another loopback name
(such as `localhost` instead of `127.0.0.1`) redirects to `APP_ORIGIN` so the
login and session cookies use the same address.
Saved recipes, plans and household accounts use `DATA_DIR` if set, otherwise
the app's `data/` directory. Keep `.env` private and back up `household.json`,
`households.json` and the `households/` directory from your save directory.

On Railway, attach a volume to your existing app service and mount it at
`/app/storage`. Set `DATA_DIR=/app/storage` in that service's Variables, then
deploy from GitHub as usual. Don't mount over `/app/data`: it contains the
bundled starter recipes. Changing `DATA_DIR` doesn't move existing saves.
If you have data to keep, back it up before changing the mount or redeploying,
then copy it into the new save directory before using the app.

## The weekly flow

1. **Pick a week.** Weeks start on Monday. Open an existing week or choose any
   date to jump to its week. When starting a fresh week, you can plan up to 12
   consecutive weeks at once using the same cooking nights and house rules.
   Existing weeks are never replaced by a multi-week plan.
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

Planning records **Adults** and **Children** separately, for 1 to 12 people
combined. Both count as one serving when scaling recipes and shopping
quantities; adjust portions to suit your household. Existing plans retain their
original total until replanned.

### Woolworths

“Copy shopping list” copies plain lines such as:

```text
800 g chicken thigh
2 lemon
60 ml olive oil
```

Ingredients marked `pantry` in a recipe are included in the shopping and
Woolworths lists by default. Untick **Include pantry items in Woolworths list**
to omit them. The checkboxes beside individual ingredients are only for tracking
shopping progress; they do not affect what gets copied.

The **Include Olive instruction** checkbox (on by default) prefixes the copied
text with “Add these items to my cart”. Turn it off for plain ingredient lines.
The separate **Just add** checkbox (off by default) adds “Just add, don't confirm”.
It can be used with or without the first instruction and requests fewer prompts,
but Olive may still require confirmation.
In the Woolworths app, choose Pick up or Delivery mode, open Olive next to the
home-page search bar, paste into the chat and send. Olive is not available on the
website or in in-store mode. The instruction does not bypass confirmations;
no supported confirmation-skip option is documented in the
[official Olive FAQ](https://www.woolworths.com.au/shop/services/olive).
Follow Olive's prompts and complete checkout yourself.
**Copy & open Woolworths** copies first, then follows the official Woolworths
website link. Your phone may open the installed app based on its link settings;
otherwise it opens the website. Automatic copying uses a fallback on local HTTP
connections; if blocked, the text is selected with manual-copy instructions and
you stay on this page. Check product matches, pack sizes and quantities yourself. **There is no
direct cart integration** and the app does not collect Woolworths credentials.
It does not scrape or automate private supermarket endpoints.

## Recipes and photo imports

The starter library includes **80 household meal cards** with generated draft
ingredients, steps, categories, primary protein, diet, servings, prep/cooking
times, notes and locally served food photography.

In **Recipes**, switch between Comfortable cards and Compact cards. Compact
cards show more recipes at once; your layout choice is remembered in that
browser.

Use **Add recipe** to type a recipe manually or select a photo of its ingredients
and method. Selecting a recipe-page photo starts the import: the browser resizes
it, sends it to Copilot and shows progress with a **Cancel reading** button.
The transcription fills an editable draft and flags ambiguities. Nothing enters
your library until you review the details, tick the review checkbox and save.
Your recipes are added alongside the starter cards in the local household
collection. This updates the current household's save file; the shipped starter
file stays unchanged.

The separate **Dish photo** section lets you choose an image file, take a photo
of the finished dish while the recipe is being read, or search for a suitable
image once the draft is ready. The recipe-page photo is
only used for transcription, not as the dish photo. JPEG, PNG, WebP and phone
HEIC/HEIF photos are supported. If your browser cannot open a HEIC/HEIF photo,
it is sent to this server for conversion before resizing; it is not saved there.

When editing a recipe, choose **Find a photo with Copilot** to turn its details
into a search phrase and look for a matching photo. When `UNSPLASH_ACCESS_KEY`
is configured, Unsplash is searched first, followed by CC0 photos from Openverse
and Wikimedia Commons. Otherwise, those two CC0 sources are used directly.
Unsplash images stay hotlinked to Unsplash and display photographer attribution;
CC0 images are stored with the recipe. The selected photo appears in the editor
for review and is saved only when you update the recipe. This sends recipe
details to Copilot and the photo sources. A broader dish-name search is tried
if the first search has no match or its photo is unavailable or rejected.
Previously shown photos are excluded when you try another search in the same
edit session. Unsplash API rate limits apply.
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
data/recipes.json    Shared starter recipe collection; edit here and redeploy to update it
data/household.json  Super admin recipes and weeks (default path, gitignored)
data/households.json Household names, IDs and salted password hashes (default path, gitignored)
data/households/     Per-household recipes and weeks, keyed by stable ID (default path, gitignored)
client/              React/Mantine application and Vite page entries
public/              Shared CSS, fonts, built client assets and local food photographs
server/recipes.ts    Recipe, photo and extraction schemas
server/planner.ts    Planning rules, alternatives, day moves and shopping aggregation
server/store.ts      Serialized, atomic JSON persistence
server/households.ts Household registry and isolated data stores
server/app.ts       Validated local HTTP API and static assets
server/copilot.ts   Server-only Copilot SDK integration
server/index.ts     Loopback server and shutdown
```

Changes to `data/recipes.json` appear for all households after redeploying, without
changing their added recipes or saved plans. Older copies of starter cards in
household files, including edits made to those copies, are no longer used.
Back up all household files listed above to preserve logins, collections and weeks.
Corrupt or unwritable storage is reported as an error, never silently replaced.

Confirmed weeks contain recipe snapshots and their shopping quantities, so
future additions to the collection don't alter a locked plan. Revision checks
prevent stale tabs overwriting newer edits. If prompted, refresh the page using
your browser before editing again.

Open a meal from your week and press **Cooked!** to mark it done, including in
a locked week. The week card shows a cooked badge; **Undo cooked** clears it.
This status is saved for the household, follows a meal when moved, and resets
when that meal is swapped. It does not change shopping quantities or checkmarks.

Shopping checkmarks and cooking progress live in the current browser's
`localStorage`; the actual recipes and weeks are saved on the server. Clearing
site data removes those checkmarks, not your saved plans. The previous starter
app's generated browser-only plan is not automatically converted to a dated
week; its old localStorage entry is left untouched.

Run **one server process for the registry and household files**. Atomic writes protect against
partial files and requests within that process are serialized; this is not a
multi-process database.

## Commands

```sh
npm run dev     # Run Express and the Vite client with API proxying
npm run auth:setup # Configure super admin credentials and app URL
npm run check   # Type-check server and client
npm test       # Rule, HTTP, storage and UI tests; no paid AI calls
npm run build  # Build client into public/build/ and server into dist/
npm start      # Run compiled server; keep public/ and data/ alongside dist/
```

## Releases

From a clean, up-to-date `main` branch, run one of:

```sh
npm run release -- patch       # 0.1.0 -> 0.1.1
npm run release -- minor       # 0.1.0 -> 0.2.0
npm run release -- major       # 0.1.0 -> 1.0.0
npm run release -- 1.2.3       # Set an explicit version
```

The command runs the tests and build, updates `package.json` and the lockfile,
commits the version, creates an annotated `vX.Y.Z` tag, and atomically pushes
the commit and tag to `origin`. A GitHub Actions workflow then re-runs the
checks and creates a GitHub Release with generated notes. The workflow requires
the repository's default `GITHUB_TOKEN` permissions; no release secret is
needed.

The release workflow does not deploy to a server. Choose a hosting target,
configure the household login and HTTPS as described above, and persist the
household data file before setting up public deployment.

## Privacy and limits

- The server binds to loopback by default. Online hosting requires household
  login, HTTPS and spending controls; see the hosting instructions above.
- Access from another phone/computer requires the explicit network opt-in.
  Camera capture and native sharing depend on device/browser support. File
  upload, editable recipe entry and PNG download are the alternatives.
- Only photo transcription and the retained original AI generation API make
  model calls. Photos and their contents are sent to GitHub Copilot and its model
  provider. Copilot may retain local session data in its normal data directory.
- Recipe photos selected from Unsplash are served from Unsplash in the browser,
  as required by its API guidelines. Photo search calls Unsplash only when
  `UNSPLASH_ACCESS_KEY` is configured.
- Monitor your Copilot allowance and configure additional-usage controls on
  GitHub. This app does not enforce a monetary spending cap. One photo task
  (extraction or search) runs at a time; failed requests can still consume
  credits.
- Always independently check allergens, ingredient labels and food-safety
  guidance. Dietary categories and cooking times are not medical or safety
  guarantees. Shopping quantities are requirements, not rounded product packs.

## Photography

Bundled photos are downloaded from Unsplash and served locally. Normal browsing
does not make third-party image requests unless a recipe uses an Unsplash API
photo, which stays hotlinked to Unsplash. Photo search uses Unsplash when
configured, then Openverse and Wikimedia Commons; chosen CC0 images are
downloaded and stored locally. Unsplash photos include required photographer
attribution and download tracking. See the
[Unsplash licence](https://unsplash.com/license) and [API guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines).

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
