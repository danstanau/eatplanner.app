import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ActionIcon, Button, Checkbox, Group, Loader, Modal, Notification, NumberInput, Paper, SegmentedControl, Select, Textarea, TextInput, useMantineColorScheme, VisuallyHidden,
} from "@mantine/core";
import {
  addDays, api, CATEGORIES, dateLabel, DAYS, ingredientLine, mondayFor, parseIngredientLines,
  PROTEINS, readRoute, RECIPE_SCOPES, shoppingText, today, weekLabel, writeRoute,
  type AppRoute, type HouseholdProfile, type HouseholdShopping, type ImageCredit, type Ingredient, type Meal, type Recipe, type RecipeScope, type Summary, type User, type Week,
} from "./shared";

type Route = AppRoute;
type Toast = { text: string; error?: boolean } | null;
type ModalState =
  | { kind: "recipe"; recipe: Recipe; servings: number; week?: string; day?: number }
  | { kind: "edit-recipe"; recipe?: Recipe }
  | { kind: "edit-week"; week: Week }
  | { kind: "swap"; day: number }
  | { kind: "custom-plan"; day: number }
  | { kind: "household"; household?: Household; mode?: "name" | "password" }
  | { kind: "share-week" }
  | { kind: "share-shopping"; week: Week; items: Ingredient[] }
  | null;
type Household = { id: string; name: string };
type Session = { enabled: boolean; authenticated: boolean; user?: User & { profile?: HouseholdProfile } };
type PlanningRules = {
  differentProteins: boolean;
  overlapIngredients: boolean;
  maxMinutes: number;
  diet: string;
  recipeScope: RecipeScope;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function useTheme() {
  const { setColorScheme } = useMantineColorScheme();
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("eatplanner.app:theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch (error) {
      console.error("Appearance preference could not be loaded:", error);
      return "system";
    }
  });
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    // Mantine owns data-mantine-color-scheme; writing it directly gets overridden by the OS preference.
    setColorScheme(theme === "system" ? "auto" : theme);
    const color = theme === "light" ? "#f4f6f5" : theme === "dark" ? "#0e1426" : undefined;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      if (color) meta.content = color;
      else meta.content = meta.media.includes("dark") ? "#0e1426" : "#f4f6f5";
    }
    try {
      if (theme === "system") localStorage.removeItem("eatplanner.app:theme");
      else localStorage.setItem("eatplanner.app:theme", theme);
    } catch (error) {
      console.error("Appearance preference could not be saved:", error);
    }
  }, [theme, setColorScheme]);
  return [theme, setTheme] as const;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={`brand${compact ? " compact" : ""}`}>
    <img src="/favicon.svg" alt="" width="64" height="64" />eatplanner<span>.app</span>
  </span>;
}

function PageHeading({ title, description }: { title: string; description?: string }) {
  return <div className="page-heading"><h1>{title}</h1>{description && <p className="lede">{description}</p>}</div>;
}

function Loading({ message }: { message: string }) {
  return <div className="loading-state" role="status"><p className="loading">{message}</p>
    <span className="skeleton-line" aria-hidden="true" /><span className="skeleton-line short" aria-hidden="true" />
    <span className="skeleton-line" aria-hidden="true" /></div>;
}

function Tag({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{help && <small>{help}</small>}</label>;
}

function countDinners(count: number) {
  return `${count} ${count === 1 ? "dinner" : "dinners"}`;
}

function peopleLabel(week: Week) {
  if (week.adults === undefined && week.children === undefined) return `${week.people} people`;
  const children = week.children ?? 0;
  const adults = week.adults ?? week.people - children;
  return `${adults} ${adults === 1 ? "adult" : "adults"}, ${children} ${children === 1 ? "child" : "children"}`;
}

export function App() {
  const [theme, setTheme] = useTheme();
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [session, setSession] = useState<Session | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [week, setWeek] = useState<Week | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [recipeFullscreen, setRecipeFullscreen] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [adminRefresh, setAdminRefresh] = useState(0);
  const [shopping, setShopping] = useState<HouseholdShopping | null>(null);
  const authenticated = Boolean(session?.authenticated);
  const profileSelected = Boolean(!session?.enabled || session.user?.profile);
  const modalTitle = modal?.kind === "recipe" ? modal.recipe.title
    : modal?.kind === "edit-recipe" ? modal.recipe ? `Edit ${modal.recipe.title}` : "Add a recipe"
      : modal?.kind === "edit-week" ? "Change planning rules"
        : modal?.kind === "swap" ? `Swap ${DAYS[modal.day]}'s dinner`
          : modal?.kind === "custom-plan" ? `${week?.meals.some((meal) => meal.day === modal.day && "type" in meal) ? "Edit" : "Add"} a plan for ${DAYS[modal.day]}`
          : modal?.kind === "household" ? !modal.household ? "Add household"
            : modal.mode === "name" ? "Change household name" : "Reset household password"
            : modal?.kind === "share-week" ? "Share this week"
              : modal?.kind === "share-shopping" ? "Share shopping list" : null;

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const run = useCallback(async (action: () => Promise<void>, control?: HTMLButtonElement | null) => {
    if (control) control.disabled = true;
    try { await action(); }
    catch (error) {
      console.error(error);
      notify(error instanceof Error ? error.message : "Something went wrong.", true);
    } finally { if (control) control.disabled = false; }
  }, [notify]);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    writeRoute(next, replace);
    setModal(null);
    setRecipeFullscreen(false);
    setRoute(readRoute());
  }, []);
  const dismissModal = useCallback(() => {
    setModal(null);
    setRecipeFullscreen(false);
    const current = readRoute();
    if (current.edit === "1" && current.recipe) navigate({ ...current, edit: undefined }, true);
    else if (current.recipe || current.edit) navigate({ ...current, recipe: undefined, day: undefined, edit: undefined }, true);
  }, [navigate]);
  useEffect(() => {
    if (modal?.kind !== "recipe") setRecipeFullscreen(false);
  }, [modal?.kind]);

  const loadSession = useCallback(async () => {
    const current = await api<Session>("/auth/session");
    setSession(current);
    if ((current.authenticated && current.user?.profile) || (!current.enabled)) setRecipes(await api<Recipe[]>("/recipes"));
    else setRecipes([]);
    return current;
  }, []);

  const loadWeek = useCallback(async (key: string) => {
    setBusy(true);
    try { setWeek(await api<Week | null>(`/weeks/${key}`)); }
    finally { setBusy(false); }
  }, []);
  const applyShopping = useCallback((next: HouseholdShopping) => {
    setShopping((current) => !current || next.revision >= current.revision ? next : current);
  }, []);
  const changeShopping = useCallback(async (path: string, body: unknown, method?: string) => {
    applyShopping(await api<HouseholdShopping>(path, body, method));
  }, [applyShopping]);

  useEffect(() => {
    if (!session || (session.enabled && (!session.authenticated || !session.user?.profile))) return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await api<HouseholdShopping>("/shopping");
        if (active) applyShopping(next);
      } catch (error) {
        if (active) notify(error instanceof Error ? error.message : "Couldn't load the shopping list.", true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [session?.enabled, session?.authenticated, session?.user?.profile?.id, applyShopping, notify]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      setLoading(true);
      try {
        const currentSession = session ?? await loadSession();
        const currentRoute = readRoute();
        if (currentSession.enabled && !currentSession.authenticated) {
          if (active) setRoute(currentRoute);
          return;
        }
        if (currentSession.enabled && !currentSession.user?.profile) {
          if (active) setRoute(currentRoute);
          return;
        }
        if (currentRoute.view === "week" && currentRoute.week) await loadWeek(currentRoute.week);
        else if (currentRoute.view === "weeks") setSummaries(await api<Summary[]>("/weeks"));
        else if (currentRoute.view === "admin") setWeek(null);
        else if (currentRoute.view === "recipes") setWeek(null);
        if (active) {
          setRoute(currentRoute);
        }
      } catch (error) {
        if (active) notify(error instanceof Error ? error.message : "Couldn't load your planner.", true);
      } finally { if (active) setLoading(false); }
    };
    void restore();
    const pop = () => { setSession(null); setModal(null); setRoute(readRoute()); };
    window.addEventListener("popstate", pop);
    return () => { active = false; window.removeEventListener("popstate", pop); };
  }, [loadSession, loadWeek, notify, session?.authenticated, route.view, route.week]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 14000 : 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!authenticated || !profileSelected) return;
    const recipe = recipes.find((item) => item.id === route.recipe);
    if (route.edit === "new") setModal({ kind: "edit-recipe" });
    else if (recipe && route.edit === "1" && session?.user && canEditRecipe(recipe, session.user)) setModal({ kind: "edit-recipe", recipe });
    else if (recipe) {
      const currentWeek = route.view === "week" && route.week ? week : null;
      const day = route.view === "week" && route.day ? Number(route.day) : undefined;
      setModal({ kind: "recipe", recipe, servings: currentWeek?.people ?? recipe.servings, week: currentWeek?.week, day });
    }
  }, [route.recipe, route.edit, route.view, route.week, route.day, recipes, authenticated, profileSelected, session?.user, week]);

  const page = useMemo(() => {
    if (!session) return <Loading message="Setting the table..." />;
    if (session.enabled && !authenticated) return <Login notify={notify} />;
    if (session.enabled && authenticated && !profileSelected) return <ProfilePicker notify={notify} onSelected={loadSession} />;
    if (loading || busy) return <Loading message={route.view === "week" ? "Opening your week..." : "Finding your weeks..."} />;
    if (route.view === "week" && route.week) return <WeekPage
      key={route.week} week={week} weekKey={route.week} user={session.user}
      onWeek={setWeek} onRoute={navigate} onModal={setModal} notify={notify} run={run} changeShopping={changeShopping} shopping={shopping}
    />;
    if (route.view === "shopping") return <HouseholdShoppingPage shopping={shopping} changeShopping={changeShopping} run={run} />;
    if (route.view === "recipes") return <RecipesPage
      recipes={recipes} route={route} user={session.user} onRoute={navigate}
    />;
    if (route.view === "admin") return <AdminPage key={adminRefresh} user={session.user} onModal={setModal} />;
    return <WeeksPage summaries={summaries} recipeCount={recipes.length} onWeek={(key) => navigate({ view: "week", week: key })}
      onPlan={(key) => navigate({ view: "week", week: key })} />;
  }, [session, authenticated, profileSelected, loading, busy, route, week, recipes, summaries, notify, run, navigate, adminRefresh, shopping, changeShopping, loadSession]);

  if (window.location.pathname === "/login" && session?.enabled && authenticated) {
    window.location.replace(new URLSearchParams(window.location.search).get("next") ?? "/");
  }

  return session?.enabled && !authenticated && window.location.pathname !== "/login"
    ? <SalesPage />
    : session?.enabled && !authenticated
    ? <Login notify={notify} theme={theme} setTheme={setTheme} />
    : session?.enabled && !profileSelected
    ? <ProfilePicker notify={notify} onSelected={loadSession} />
    : <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/"><img src="/favicon.svg" alt="" width="64" height="64" />eatplanner<span>.app</span></a>
        <nav aria-label="Main navigation">
          <Button id="nav-weeks" className={`nav-link${route.view === "week" || route.view === "weeks" ? " active" : ""}`} variant="subtle"
            aria-current={route.view === "week" || route.view === "weeks" ? "page" : undefined}
            onClick={() => navigate({ view: "weeks" })}><svg className="icon" aria-hidden="true"><use href="/icons.svg#calendar" /></svg><span>Weeks</span></Button>
          <Button id="nav-recipes" className={`nav-link${route.view === "recipes" ? " active" : ""}`} variant="subtle"
            aria-current={route.view === "recipes" ? "page" : undefined} onClick={() => navigate({ view: "recipes" })}>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#book" /></svg><span>Recipes</span></Button>
          <Button id="nav-shopping" className={`nav-link${route.view === "shopping" ? " active" : ""}`} variant="subtle"
            aria-current={route.view === "shopping" ? "page" : undefined} onClick={() => navigate({ view: "shopping" })}>
            <span>Shopping list{shopping ? ` (${shopping.items.length})` : ""}</span></Button>
          <Button id="add-recipe" className="button small" onClick={() => {
            const current = readRoute();
            navigate(current.view === "week" ? { ...current, edit: "new" } : { view: "recipes", edit: "new" });
            setModal({ kind: "edit-recipe" });
          }}>Add recipe</Button>
        </nav>
        {session?.user?.isAdmin && <ActionIcon id="nav-admin" className="admin-link" variant="subtle" aria-label="Admin" title="Admin"
          aria-current={route.view === "admin" ? "page" : undefined} onClick={() => navigate({ view: "admin" })}>
          <svg className="icon" aria-hidden="true"><use href="/icons.svg#settings" /></svg></ActionIcon>}
        {session?.enabled && session.user?.profile && <Button id="switch-profile" className="text-button" variant="subtle"
          onClick={() => void run(async () => {
            await api("/profiles/clear", {});
            await loadSession();
          })}>
          {session.user.profile.name}
        </Button>}
        {session?.enabled && <Button id="sign-out" className="text-button" variant="subtle" onClick={() => void run(async () => {
          await api("/auth/logout", {});
          window.location.assign("/login");
        })}>Sign out</Button>}
      </header>
      <main id="view" tabIndex={-1}>{page}</main>
      <footer><Brand compact />
        <label className="theme-picker">Appearance
          <select value={theme} onChange={(event) => setTheme(event.currentTarget.value as "system" | "light" | "dark")}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
      </footer>
      {toast && <div className="toast" role={toast.error ? "alert" : "status"}>
        <Notification
          color={toast.error ? "red" : "green"}
          title={toast.error ? "Something went wrong" : "Done"}
          withCloseButton
          closeButtonProps={{ "aria-label": "Dismiss notification" }}
          onClose={() => setToast(null)}
        >
          {toast.text}
        </Notification>
      </div>}
      <Modal opened={modal !== null} onClose={dismissModal}
        title={modalTitle ? <VisuallyHidden>{modalTitle}</VisuallyHidden> : null}
        withCloseButton={false} size={modal?.kind === "edit-recipe" ? "xl" : "lg"} centered={false}
        classNames={{ header: "modal-a11y-header", content: `app-modal${recipeFullscreen && modal?.kind === "recipe" ? " app-modal-fullscreen" : ""}`, body: "app-modal-body" }}>
        <div className="dialog-actions">
          {modal?.kind === "recipe" && <Button className="dialog-icon-button" variant="subtle"
            aria-label={recipeFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={recipeFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            onClick={() => setRecipeFullscreen((current) => !current)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={recipeFullscreen
                ? "M8 3v5H3M16 3v5h5M8 21v-5H3m13 5v-5h5"
                : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"} />
            </svg>
          </Button>}
          {modal?.kind === "recipe" && session?.user && canEditRecipe(modal.recipe, session.user) &&
            <Button className="dialog-icon-button" variant="subtle" aria-label="Edit recipe" title="Edit recipe"
              onClick={() => {
                const current = readRoute();
                navigate({ ...current, edit: "1" });
                setModal({ kind: "edit-recipe", recipe: modal.recipe });
              }}>✎</Button>}
          <Button className="close-button" variant="subtle" aria-label="Close dialog" onClick={dismissModal}>×</Button>
        </div>
        {modal?.kind === "recipe" && <RecipeDetail recipe={modal.recipe} servings={modal.servings} week={modal.week} day={modal.day}
          currentWeek={week} user={session?.user} onWeek={setWeek} onClose={dismissModal} notify={notify} />}
        {modal?.kind === "edit-recipe" && <RecipeEditor recipe={modal.recipe} onSaved={(saved) => {
          setRecipes((current) => modal.recipe ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
          setModal(null);
          const currentRoute = readRoute();
          if (currentRoute.edit || currentRoute.recipe) navigate({ ...currentRoute, recipe: undefined, day: undefined, edit: undefined }, true);
          notify(modal.recipe ? "Recipe updated." : "Saved to your collection.");
        }} notify={notify} />}
        {modal?.kind === "edit-week" && <PlanningForm week={modal.week} weekKey={modal.week.week} dialogTitle="Change planning rules"
          onSaved={(updated) => { setWeek(updated); setModal(null); notify("Draft updated."); }} />}
        {modal?.kind === "swap" && week && <SwapPicker week={week} day={modal.day} onChoose={async (recipeId) => {
          const updated = await api<Week>(`/weeks/${week.week}/swap`, { day: modal.day, recipeId, revision: week.revision });
          setWeek(updated);
          setModal(null);
          notify("Dinner swapped.");
        }} />}
        {modal?.kind === "custom-plan" && week && <CustomPlanEditor week={week} day={modal.day} onSaved={(updated) => {
          setWeek(updated);
          setModal(null);
          notify("Plan saved.");
        }} />}
        {modal?.kind === "household" && <HouseholdEditor household={modal.household} mode={modal.mode} onSaved={(message) => {
          setModal(null);
          setAdminRefresh((value) => value + 1);
          notify(message);
        }} />}
        {modal?.kind === "share-week" && week && <ShareWeek week={week} />}
        {modal?.kind === "share-shopping" && <ShareShopping week={modal.week} items={modal.items} notify={notify} />}
      </Modal>
    </div>;
}

function canEditRecipe(recipe: Recipe, user: User) {
  return recipe.source === "personal" && recipe.householdId === user.id;
}

function HouseholdShoppingPage({ shopping, changeShopping, run }: {
  shopping: HouseholdShopping | null;
  changeShopping: (path: string, body: unknown, method?: string) => Promise<void>;
  run: (action: () => Promise<void>, control?: HTMLButtonElement | null) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return <>
    <PageHeading title="Shopping list" description="A shared list for everyone in your household." />
    <form className="household-shopping-add" onSubmit={(event) => {
      event.preventDefault();
      const value = name.trim();
      if (!value) return;
      void run(async () => { await changeShopping("/shopping", { names: [value] }); setName(""); });
    }}>
      <TextInput label="Add an item" value={name} maxLength={200} onChange={(event) => setName(event.currentTarget.value)} />
      <Button className="button" type="submit" disabled={!name.trim()}>Add item</Button>
    </form>
    {!shopping ? <Loading message="Loading shopping list..." /> : shopping.items.length === 0
      ? <p className="muted">Your shopping list is empty. Add an item above.</p>
      : <div className="household-shopping-list">{shopping.items.map((item) =>
        <HouseholdShoppingRow key={item.id} item={item} changeShopping={changeShopping} run={run} />)}</div>}
  </>;
}

function HouseholdShoppingRow({ item, changeShopping, run }: {
  item: HouseholdShopping["items"][number];
  changeShopping: (path: string, body: unknown, method?: string) => Promise<void>;
  run: (action: () => Promise<void>, control?: HTMLButtonElement | null) => Promise<void>;
}) {
  const [name, setName] = useState(item.name);
  useEffect(() => { setName(item.name); }, [item.name]);
  const path = `/shopping/${item.id}`;
  return <form className="household-shopping-row" onSubmit={(event) => {
    event.preventDefault();
    void run(() => changeShopping(path, { name: name.trim() }, "PATCH"));
  }}>
    <Checkbox checked={item.checked} aria-label={`Mark ${item.name} as ${item.checked ? "needed" : "bought"}`}
      onChange={(event) => { const checked = event.currentTarget.checked; void run(() => changeShopping(path, { checked }, "PATCH")); }} />
    <div className="household-shopping-item">
      <TextInput aria-label={`Edit ${item.name}`} value={name} maxLength={200} onChange={(event) => setName(event.currentTarget.value)} />
      {item.createdBy && <small className="muted">Added by {item.createdBy.name}</small>}
    </div>
    <Button className="button secondary" type="submit" disabled={!name.trim() || name.trim() === item.name}>Save</Button>
    <Button className="button secondary" type="button" aria-label={`Remove ${item.name}`}
      onClick={() => void run(() => changeShopping(path, {}, "DELETE"))}>Remove</Button>
  </form>;
}

function SalesPage() {
  return <div className="sales-page">
    <header className="sales-nav">
      <a className="brand" href="/"><img src="/favicon.svg" alt="" width="64" height="64" />eatplanner<span>.app</span></a>
      <nav aria-label="Page navigation">
        <a className="sales-nav-how" href="#how-it-works">How it works</a>
        <a className="sales-signin" href="/login">Sign in <span aria-hidden="true">→</span></a>
        <a className="sales-register" role="link" aria-disabled="true" aria-describedby="register-note" tabIndex={-1}>
          Register <span className="sales-soon">Coming soon</span>
        </a>
      </nav>
    </header>

    <main>
      <section className="sales-hero">
        <div className="sales-hero-copy">
          <p className="sales-eyebrow"><span aria-hidden="true">✳</span> A calmer way to plan dinner</p>
          <h1>Make a plan.<br /><span>Love dinner again.</span></h1>
          <p className="sales-lede">A week of dinners, sorted around your household. Pick your nights, find meals everyone can get behind, and finish with one ready-to-go shopping list.</p>
          <div className="sales-actions">
            <a className="sales-primary" href="/login">Sign in to your planner <span aria-hidden="true">→</span></a>
            <a className="sales-secondary" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
          </div>
          <p className="sales-reassurance"><span aria-hidden="true">✓</span> Made for your household, not another meal-kit subscription</p>
        </div>

        <div className="sales-hero-art" aria-label="A preview of a week of planned dinners">
          <div className="sales-note"><span className="sales-note-icon" aria-hidden="true">✳</span><span>One less thing<br />to figure out.</span></div>
          <div className="sales-board">
            <div className="sales-board-heading"><div><span className="sales-board-kicker">YOUR WEEK, AT A GLANCE</span><h2>Good things cooking</h2></div><span className="sales-week-pill">5 dinners</span></div>
            <div className="sales-meal-list">
              <article className="sales-meal"><img src="/images/pasta.jpg" alt="" /><span className="sales-meal-day">MON</span><span className="sales-meal-name">Creamy tomato pasta</span><span className="sales-meal-time">25 min</span></article>
              <article className="sales-meal"><img src="/images/chicken.jpg" alt="" /><span className="sales-meal-day">TUE</span><span className="sales-meal-name">Lemony roast chicken</span><span className="sales-meal-time">45 min</span></article>
              <article className="sales-meal"><img src="/images/salmon.jpg" alt="" /><span className="sales-meal-day">WED</span><span className="sales-meal-name">Sticky salmon bowls</span><span className="sales-meal-time">30 min</span></article>
            </div>
            <div className="sales-board-footer"><span><span className="sales-check" aria-hidden="true">✓</span> Your list is taking shape</span><span>12 ingredients</span></div>
          </div>
          <span className="sales-spark sales-spark-one" aria-hidden="true">✳</span>
          <span className="sales-spark sales-spark-two" aria-hidden="true">✦</span>
        </div>
      </section>

      <section className="sales-how" id="how-it-works">
        <div className="sales-section-intro">
          <p className="sales-eyebrow">From “what’s for dinner?” to done</p>
          <h2>A little plan goes{" "}<br />a long way.</h2>
          <p>Keep the decisions that matter. Let the busywork take care of itself.</p>
        </div>
        <div className="sales-steps">
          <article className="sales-step">
            <span className="sales-step-number">01</span>
            <span className="sales-step-icon" aria-hidden="true">◷</span>
            <h3>Choose your nights</h3>
            <p>Pick the evenings you need covered, how many people are eating, and the kind of meals that suit your week.</p>
          </article>
          <article className="sales-step">
            <span className="sales-step-number">02</span>
            <span className="sales-step-icon" aria-hidden="true">✳</span>
            <h3>Make it your menu</h3>
            <p>Get dinner ideas to start from. Swap a meal, tweak the plan, or bring in recipes your household already loves.</p>
          </article>
          <article className="sales-step">
            <span className="sales-step-number">03</span>
            <span className="sales-step-icon" aria-hidden="true">✓</span>
            <h3>Shop once, feel ready</h3>
            <p>Lock in your week to bring ingredients together in one list. Share it, take it shopping, and enjoy having a plan.</p>
          </article>
        </div>
      </section>

      <section className="sales-last-word">
        <div><p className="sales-eyebrow">Dinner, with a plan</p><h2>Your week is waiting<br />to come together.</h2></div>
        <div className="sales-last-actions">
          <a className="sales-primary" href="/login">Sign in to eatplanner <span aria-hidden="true">→</span></a>
          <span id="register-note" className="sales-register-note">New household registration isn’t available yet.</span>
        </div>
      </section>
    </main>
    <footer className="sales-footer"><a className="brand" href="/"><img src="/favicon.svg" alt="" width="64" height="64" />eatplanner<span>.app</span></a><span>Make room for good dinners.</span></footer>
  </div>;
}

function PlanningForm({ week, weekKey, onSaved, dialogTitle }: {
  week: Week | null;
  weekKey: string;
  onSaved: (week: Week) => void;
  dialogTitle?: string;
}) {
  const [selected, setSelected] = useState<number[]>(week ? week.meals.map((meal) => meal.day) : [0, 1, 2, 3, 4]);
  const [adults, setAdults] = useState<number | string>(week?.adults ?? (week?.people ?? 2) - (week?.children ?? 0));
  const [children, setChildren] = useState<number | string>(week?.children ?? 0);
  const [diet, setDiet] = useState(week?.rules.diet ?? "anything");
  const [maxMinutes, setMaxMinutes] = useState(String(week?.rules.maxMinutes ?? 60));
  const [scope, setScope] = useState<RecipeScope>(week?.rules.recipeScope ?? "starter-and-household");
  const [different, setDifferent] = useState(week?.rules.differentProteins ?? true);
  const [overlap, setOverlap] = useState(week?.rules.overlapIngredients ?? true);
  const [weeksCount, setWeeksCount] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const adultCount = Number(adults);
      const childCount = Number(children);
      const planning = {
        days: selected, people: adultCount + childCount, adults: adultCount, children: childCount,
        rules: { differentProteins: different, overlapIngredients: overlap, maxMinutes: Number(maxMinutes), diet, recipeScope: scope },
        revision: week?.revision,
      };
      const count = week ? 1 : Number(weeksCount);
      const planned = count === 1
        ? await api<Week>(`/weeks/${weekKey}/plan`, planning)
        : (await api<Week[]>("/weeks/plan", { ...planning, startWeek: weekKey, count }))[0];
      onSaved(planned);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The week couldn't be planned.");
    } finally { setSubmitting(false); }
  }
  return <>  {dialogTitle && <h2>{dialogTitle}</h2>}
  <form className="planning-form" onSubmit={(event) => void submit(event)}>
    <div className="form-section">
      <h2>Which nights are we cooking?</h2>
      <p className="muted">Tap the days you need dinner. Leave space for leftovers and nights out.</p>
      <div className="day-picker" role="group" aria-label="Days needing dinner">{DAYS.map((day, index) =>
        <button key={day} type="button" className="day-toggle" aria-pressed={selected.includes(index)} aria-label={`Plan dinner for ${day}`}
          onClick={() => setSelected((value) => value.includes(index) ? value.filter((item) => item !== index) : [...value, index].sort())}>
          <span>{day.slice(0, 3)}</span><strong>{dateLabel(addDays(weekKey, index), { day: "numeric" })}</strong>
          <span className="day-check" aria-hidden="true">✓</span>
        </button>)}</div>
      <div className="day-picker-footer"><span className="selection-count">{countDinners(selected.length)} to plan</span>
        <div className="quick-pick"><span>Quick pick</span>{[3, 5, 7].map((number) =>
          <Button className="text-button" variant="subtle" key={number} onClick={() => setSelected(DAYS.map((_, index) => index).slice(0, number))}>{number} dinners</Button>)}</div>
      </div>
      {!week && <Field label="Plan ahead" help="Use these cooking nights and house rules for each week.">
        <select value={weeksCount} onChange={(event) => setWeeksCount(event.currentTarget.value)}>
          {Array.from({ length: 12 }, (_, index) => <option value={index + 1} key={index}>{index + 1} {index === 0 ? "week" : "weeks"}</option>)}
        </select>
      </Field>}
    </div>
    <div className="form-section"><h2>Who's eating, and how?</h2>
      <div className="form-grid">
        <Field label="Adults"><NumberInput value={adults} onChange={setAdults} min={0} max={12} required /></Field>
        <Field label="Children"><NumberInput value={children} onChange={setChildren} min={0} max={12} required /></Field>
      </div>
      <p className="muted">Plan for 1 to 12 people in total. Each adult and child counts as one serving; adjust portions to suit your household.</p>
      <div className="form-grid">
        <Field label="How we eat"><select value={diet} onChange={(event) => setDiet(event.currentTarget.value)}>
          <option value="anything">A bit of everything</option><option value="vegetarian">Vegetarian</option>
          <option value="vegan">Vegan</option><option value="pescatarian">Pescatarian</option>
        </select></Field>
        <Field label="Total time per meal"><select value={maxMinutes} onChange={(event) => setMaxMinutes(event.currentTarget.value)}>
          {[20, 30, 45, 60, 90, 180].map((time) => <option value={time} key={time}>{time === 180 ? "Any time (up to 3 hours)" : `${time} minutes`}</option>)}
        </select></Field>
      </div>
      <Field label="Recipe source"><select value={scope} onChange={(event) => setScope(event.currentTarget.value as RecipeScope)}>
        {Object.entries(RECIPE_SCOPES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </select></Field>
      <label className="check-field"><Checkbox checked={different} onChange={(event) => setDifferent(event.currentTarget.checked)} />
        <span><strong>A different protein each dinner</strong><small>No repeated primary protein in the week. Includes tofu, beans, eggs and cheese.</small></span></label>
      <label className="check-field"><Checkbox checked={overlap} onChange={(event) => setOverlap(event.currentTarget.checked)} />
        <span><strong>Some overlapping ingredients</strong><small>Favour shared fresh ingredients, for a shorter shopping list and less waste.</small></span></label>
    </div>
    {error && <p className="notice" role="alert">{error}</p>}
    <div className="form-bottom"><Button className="button" type="submit" disabled={!selected.length || submitting}>
      {submitting ? "Planning..." : week ? `Replan ${countDinners(selected.length)}` : weeksCount === "1" ? `Plan ${countDinners(selected.length)}` : `Plan ${weeksCount} weeks`}
    </Button></div>
  </form></>;
}

function householdKey(user?: User, suffix = "") {
  const household = user && !user.isAdmin ? `household:${user.id}:` : "";
  return `eatplanner.app:${household}${suffix}`;
}

function ShoppingPanel({ week, user, notify, onShare, changeShopping, shopping }: {
  week: Week;
  user?: User;
  notify: (message: string, error?: boolean) => void;
  onShare: (includePantry: boolean, haveItems: Set<string>) => void;
  changeShopping: (path: string, body: unknown, method?: string) => Promise<void>;
  shopping: HouseholdShopping | null;
}) {
  const storageKey = householdKey(user, `have:${week.week}:${week.revision}`);
  const [includePantry, setIncludePantry] = useState(true);
  const [olive, setOlive] = useState(true);
  const [productPreference, setProductPreference] = useState<"any" | "specials" | "premium">("any");
  const [status, setStatus] = useState("");
  const [haveItems, setHaveItems] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      const values: unknown = JSON.parse(saved ?? "[]");
      if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) throw new Error("Invalid saved pantry checklist.");
      return new Set(values);
    } catch (error) {
      console.error(error);
      notify("The saved 'already have it' checks could not be loaded. Your confirmed list is safe.", true);
      return new Set();
    }
  });
  const items = week.shoppingList;
  const itemsToBuy = items.filter((item) => (includePantry || !item.pantry) && !haveItems.has(`${item.name}|${item.unit}`));
  const lines = itemsToBuy.map((item) => ingredientLine(item));
  const seen = new Set(lines.map((line) => line.toLowerCase()));
  for (const item of shopping?.items ?? []) {
    if (!item.checked && !seen.has(item.name.toLowerCase())) {
      lines.push(item.name);
      seen.add(item.name.toLowerCase());
    }
  }
  const text = lines.join("\n");
  const preferenceText = productPreference === "specials"
    ? "Please prefer specials and lower-priced suitable alternatives when available."
    : productPreference === "premium"
      ? "Please prefer premium products and brands when available."
      : "";
  const instructions = [
    olive
      ? "Add every ingredient and quantity listed below directly to my cart without asking me to confirm items one by one. Match available pack sizes and quantities as closely as possible, rounding up or adding extra packs if needed. If an exact match is unavailable, choose the closest suitable in-stock option. Never proceed to checkout or payment. I will review the cart before checkout."
      : "",
    olive && preferenceText ? preferenceText : "",
    olive && preferenceText
      ? "This is a preference, not a requirement: do not skip an ingredient if no preferred match is available. Add the closest suitable in-stock product at its usual price instead."
      : "",
  ].filter(Boolean);
  const copyText = !shopping ? "" : instructions.length && text ? `${instructions.join("\n")}\n\n${text}` : text;
  const alreadyHave = items.filter((item) => haveItems.has(`${item.name}|${item.unit}`)).length;

  function toggle(key: string) {
    const updated = new Set(haveItems);
    if (updated.has(key)) updated.delete(key);
    else updated.add(key);
    setHaveItems(updated);
    try { localStorage.setItem(storageKey, JSON.stringify([...updated])); }
    catch (error) { console.error(error); notify("This browser couldn't save your 'already have it' checks.", true); }
  }

  async function copy(openShop = false) {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(copyText); copied = true; }
      catch (error) { console.error("Clipboard access failed:", error); }
    }
    if (!copied) {
      const area = document.querySelector<HTMLTextAreaElement>("#shopping-copy-fallback");
      if (area) {
        area.focus();
        area.select();
        try { copied = document.execCommand("copy"); }
        catch (error) { console.error("Clipboard fallback failed:", error); }
      }
    }
    setStatus(copied
      ? olive ? "Ingredients copied. Open Olive in the Woolworths app, paste into the chat and send." : "Ingredients copied. Paste into Olive or a supported Woolworths list-entry field."
      : "Your browser couldn't copy automatically. The ingredients are selected: press and hold, then tap Copy.");
    if (openShop && copied) window.location.assign("https://www.woolworths.com.au/");
  }

  return <section className="shopping-panel" id="shopping">
    <div className="section-bar"><div><h2>Shopping list</h2></div>
      <div className="shopping-share-actions">
        <Button className="button secondary" disabled={!itemsToBuy.length} onClick={() => void (async () => {
          try {
            await changeShopping("/shopping", { names: itemsToBuy.map((item) => ingredientLine(item)) });
            notify("Ingredients added to your household shopping list.");
          } catch (error) { notify(error instanceof Error ? error.message : "Couldn't add ingredients.", true); }
        })()}>Add to household list</Button>
        <Button className="button" disabled={!shopping} onClick={() => void copy()}>Copy shopping list</Button>
        <Button className="button secondary" onClick={() => onShare(includePantry, haveItems)}>Share shopping list</Button>
      </div>
    </div>
    <p className="muted">Combined and scaled for {peopleLabel(week)}. Quantities are recipe amounts, not supermarket pack sizes. Tick <strong>Already have it</strong> to leave an ingredient off the copied list.</p>
    <p className="muted">{shopping ? "Copying also includes unchecked items from your household shopping list. Identical lines are included once." : "Loading your household shopping list before copying."}</p>
    <label className="check-field compact"><Checkbox checked={includePantry} onChange={(event) => setIncludePantry(event.currentTarget.checked)} />
      <span>Include unchecked pantry items in Woolworths list</span></label>
    <div className="shopping-layout">
      <div>
        <p className="shopping-progress" role="status" aria-live="polite">
          {items.length ? `${itemsToBuy.length} to buy · ${alreadyHave} already have` : "No items in this list."}</p>
        {items.some((item) => item.pantry) && <section className="shopping-group pantry-group" aria-labelledby="pantry-items-title">
          <div className="shopping-group-heading"><h3 id="pantry-items-title">Pantry staples</h3><Tag>Check what you have</Tag></div>
          <p>These are often kept on hand. Tick <strong>Already have it</strong> to skip it, or untick “Include unchecked pantry items” to leave all pantry items off the Woolworths list.</p>
          <div className="shopping-checklist">{items.filter((item) => item.pantry).map((item) => {
            const key = `${item.name}|${item.unit}`;
            const onHand = haveItems.has(key);
            return <label className={`shopping-item pantry-item${onHand ? " is-on-hand" : ""}`} key={key}>
              <Checkbox checked={onHand} aria-label={`Already have ${item.name}`} onChange={() => toggle(key)} />
              <span>{ingredientLine(item)}</span>
              <span className="shopping-item-state">{onHand ? "Already have it" : "Need to buy"}</span>
            </label>;
          })}</div>
        </section>}
        <section className="shopping-group" aria-labelledby="other-items-title">
          <h3 id="other-items-title">Other ingredients</h3>
          <div className="shopping-checklist">{items.filter((item) => !item.pantry).map((item) => {
            const key = `${item.name}|${item.unit}`;
            const onHand = haveItems.has(key);
            return <label className={`shopping-item${onHand ? " is-on-hand" : ""}`} key={key}>
              <Checkbox checked={onHand} aria-label={`Already have ${item.name}`} onChange={() => toggle(key)} />
              <span>{ingredientLine(item)}</span>
              <span className="shopping-item-state">{onHand ? "Already have it" : "Need to buy"}</span>
            </label>;
          })}</div>
        </section>
      </div>
      <div>
        <h3>Take your ingredients to Woolworths</h3>
        <label className="check-field compact"><Checkbox checked={olive} onChange={(event) => setOlive(event.currentTarget.checked)} />
          <span>Tell Olive to add all ingredients to my cart</span></label>
        <div className="shopping-preference">
          <span className="field-label">Product preference <span className="muted">(for Olive)</span></span>
          <SegmentedControl id="shopping-product-preference" aria-label="Product preference for Olive"
            className="shopping-preference-control" classNames={{ label: "shopping-preference-segment" }}
            fullWidth disabled={!olive} value={productPreference}
            onChange={(value) => {
              if (value === "any" || value === "specials" || value === "premium") setProductPreference(value);
            }}
            data={[
              { label: "Any", value: "any" },
              { label: "Specials & lower prices", value: "specials" },
              { label: "Premium", value: "premium" },
            ]} />
          <small>These are requests for Olive, not guarantees. Check its product suggestions before adding them.</small>
        </div>
        <ol className="shopping-instructions">
          <li>Choose which pantry items to include and an optional Olive product preference, then copy your ingredients.</li>
          <li>In the Woolworths app, choose Pick up or Delivery mode and open Olive beside the home-page search bar. Press and hold the chat field, tap Paste, then send.</li>
          <li>Follow Olive's prompts and check product matches, pack sizes and quantities. You complete checkout yourself.</li>
        </ol>
        <div className="shopping-copy-actions">
          <Button className="button" disabled={!shopping} onClick={() => void copy(true)}>Copy &amp; open Woolworths</Button>
          <a className="button secondary" href="https://www.woolworths.com.au/">Open Woolworths</a>
        </div>
        <p className="muted" role="status" aria-live="polite">{status}</p>
        <Textarea id="shopping-copy-fallback" classNames={{ input: "shopping-text" }} rows={12} value={copyText} readOnly aria-label="Combined shopping list for copying" />
        <p className="fineprint">The Woolworths link may open the installed app if your phone allows it; otherwise it opens the website. Olive is only available in the app, not on the website or in in-store mode. Nothing is sent to Olive automatically. <a href="https://www.woolworths.com.au/shop/services/olive">Woolworths Olive help</a></p>
      </div>
    </div>
  </section>;
}

function RecipeDetail({ recipe, servings, week, day, currentWeek, user, onWeek, onClose, notify }: {
  recipe: Recipe;
  servings: number;
  week?: string;
  day?: number;
  currentWeek: Week | null;
  user?: User;
  onWeek: (week: Week) => void;
  onClose: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [gatheredIngredients, setGatheredIngredients] = useState<Set<string>>(() => new Set());
  useEffect(() => setGatheredIngredients(new Set()), [recipe.id]);
  const meal = week && day !== undefined && currentWeek?.week === week
    ? currentWeek.meals.find((item): item is Extract<Meal, { recipe: Recipe }> =>
      item.day === day && "recipe" in item && item.recipe.id === recipe.id)
    : undefined;
  const storageKey = week !== undefined && day !== undefined
    ? householdKey(user, `cook:${week}:${day}:${recipe.id}`)
    : undefined;
  useEffect(() => {
    if (!storageKey) return;
    try {
      const current = localStorage.getItem(storageKey);
      const legacy = !user || user.isAdmin ? localStorage.getItem(`mealplan.ai:cook:${week}:${day}:${recipe.id}`) : null;
      const value = Number(current ?? legacy ?? 0);
      if (Number.isInteger(value) && value >= 0 && value < recipe.steps.length) setStep(value);
      if (current === null && value > 0) localStorage.setItem(storageKey, String(value));
    } catch (error) { console.error(error); notify("Cooking progress couldn't be restored in this browser.", true); }
  }, [storageKey, recipe.steps.length, user, week, day, recipe.id, notify]);
  function changeStep(next: number) {
    const value = Math.max(0, Math.min(recipe.steps.length - 1, next));
    setStep(value);
    if (storageKey) {
      try { localStorage.setItem(storageKey, String(value)); }
      catch (error) { console.error(error); notify("Cooking progress couldn't be saved in this browser.", true); }
    }
  }
  const [showAll, setShowAll] = useState(true);
  const [busy, setBusy] = useState(false);
  const credit = recipe.imageCredit;
  const servingsMultiplier = servings / recipe.servings;

  async function cooked() {
    if (!week || day === undefined || !meal) return;
    setBusy(true);
    try {
      const updated = await api<Week>(`/weeks/${week}/cooked`, {
        day, recipeId: recipe.id, cooked: !meal.cooked,
      });
      onWeek(updated);
      notify(meal.cooked ? "Cooking status cleared." : "Marked as cooked.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The cooking status couldn't be saved.", true);
    } finally { setBusy(false); }
  }

  return <div className="recipe-detail">
    <img className="recipe-hero" src={recipe.image} alt={recipe.title} />
    {credit && <p className="fineprint photo-credit">Photo by <a href={credit.creatorUrl ?? credit.sourceUrl} target="_blank" rel="noreferrer">{credit.creator}</a>
      {credit.creatorUrl ? <> on <a href={credit.sourceUrl} target="_blank" rel="noreferrer">Unsplash</a></> : `, ${credit.license} `}
      {" "}(<a href={credit.licenseUrl} target="_blank" rel="noreferrer">{credit.license}</a>)</p>}
    <div className="recipe-intro">
      <p className="recipe-kind">{CATEGORIES[recipe.category]}, {PROTEINS[recipe.protein].toLowerCase()}</p>
      <h2>{recipe.title}</h2><p className="muted">{recipe.description}</p>
      <div className="recipe-stats"><span>Serves <strong>{servings}</strong></span><span>Prep <strong>{recipe.prepMinutes} min</strong></span>
        <span>Cook <strong>{recipe.cookMinutes} min</strong></span><span>{recipe.diet[0].toUpperCase() + recipe.diet.slice(1)}</span></div>
      {meal && <div className="action-row"><Button className="button" disabled={busy} onClick={() => void cooked()}>{meal.cooked ? "Undo cooked" : "Cooked!"}</Button>
        <span className="muted" role="status">{meal.cooked ? "Cooked." : "Not cooked yet."}</span></div>}
      <div className="recipe-layout">
        <section><h3>What you'll need</h3><p className="muted ingredient-check-hint">Tick ingredients as you gather them for cooking.</p>
          <div className="recipe-ingredients">{recipe.ingredients.map((item) => {
            const key = `${item.name}|${item.unit}`;
            return <label className="shopping-item" key={key}>
              <Checkbox checked={gatheredIngredients.has(key)} aria-label={`Gathered ${item.name}`}
                onChange={() => setGatheredIngredients((current) => {
                  const updated = new Set(current);
                  if (updated.has(key)) updated.delete(key);
                  else updated.add(key);
                  return updated;
                })} />
              <span>{ingredientLine(item, servingsMultiplier)}</span>
            </label>;
          })}</div></section>
        <section className="cook-mode" aria-label="Cooking method">
          <button type="button" className="all-steps-toggle" onClick={() => setShowAll((value) => !value)}>{showAll ? "Back to step-by-step" : "See the whole method"}</button>
          {showAll ? <ol className="all-steps">{recipe.steps.map((item, index) => <li key={index}>{item}</li>)}</ol> :
            <div className="single-step"><p className="eyebrow">Step {step + 1} of {recipe.steps.length}</p>
              <p className="step-instruction" tabIndex={-1}>{recipe.steps[step]}</p>
              <div className="step-controls">
                <Button className="button secondary" disabled={step === 0} onClick={() => changeStep(step - 1)}>Previous step</Button>
                <Button className="button" disabled={step === recipe.steps.length - 1} onClick={() => changeStep(step + 1)}>
                  {step === recipe.steps.length - 1 ? "Ready to serve" : "Next step"}</Button>
              </div>
            </div>}
        </section>
      </div>
      {recipe.notes && <p className="notice">{recipe.notes}</p>}
      <p className="fineprint">Check allergies and ingredient labels yourself. Times are a guide; make sure food is cooked safely. Photos are serving suggestions.</p>
      <Button className="text-button" variant="subtle" onClick={onClose}>Close recipe</Button>
    </div>
  </div>;
}

function ShareWeek({ week }: { week: Week }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = "";
    let disposed = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) { setError("This browser cannot create a share card."); return; }
    const meals = DAYS.map((day, index) => ({ day, meal: week.meals.find((item) => item.day === index) }));
    context.font = "600 34px sans-serif";
    const rows = meals.map(({ meal }) => {
      const title = meal ? "recipe" in meal ? meal.recipe.title : meal.title : "Night off";
      const lines: string[] = [];
      let line = "";
      for (const word of title.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (context.measureText(next).width > 650 && line) { lines.push(line); line = word; }
        else line = next;
      }
      if (line) lines.push(line);
      return lines;
    });
    const contentHeight = rows.reduce((total, lines) => total + Math.max(100, lines.length * 42 + 40), 0);
    canvas.width = 1080;
    canvas.height = 320 + contentHeight + 130;
    context.fillStyle = "#f4f6f5"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#1b3fa0"; context.fillRect(0, 0, canvas.width, 250);
    context.fillStyle = "#fff"; context.font = "800 78px sans-serif"; context.fillText("Dinner this week", 70, 130);
    context.font = "32px sans-serif"; context.fillText(weekLabel(week.week), 70, 190);
    let y = 320;
    meals.forEach(({ day, meal }, index) => {
      context.fillStyle = meal ? "#1b3fa0" : "#4a5470";
      context.font = "800 38px sans-serif";
      context.fillText(day, 70, y + 38);
      context.fillStyle = meal ? "#131c3a" : "#4a5470";
      context.font = "600 34px sans-serif";
      rows[index].forEach((line, lineIndex) => context.fillText(line, 330, y + 38 + lineIndex * 42));
      const rowHeight = Math.max(100, rows[index].length * 42 + 40);
      y += rowHeight;
      context.strokeStyle = "#d3d9e4"; context.beginPath(); context.moveTo(70, y); context.lineTo(1010, y); context.stroke();
    });
    const footer = `${countDinners(week.meals.length)} for ${peopleLabel(week)}. ${week.status === "confirmed" ? "Locked in." : "Draft, not locked in yet."}`;
    context.fillStyle = "#131c3a"; context.font = "28px sans-serif"; context.fillText(footer.slice(0, 65), 70, y + 48);
    context.fillStyle = "#4a5470"; context.font = "24px sans-serif"; context.fillText("eatplanner.app", 70, y + 92);
    canvas.toBlob((blob) => {
      if (disposed) return;
      if (!blob) { setError("The share card couldn't be created."); return; }
      current = URL.createObjectURL(blob);
      setUrl(current);
    }, "image/png");
    return () => { disposed = true; if (current) URL.revokeObjectURL(current); };
  }, [week]);
  const fileName = `eatplanner-${week.week}.png`;
  async function share() {
    try {
      if (!url || !navigator.canShare) { setError("This browser can't share files. Download the PNG instead."); return; }
      const response = await fetch(url);
      const file = new File([await response.blob()], fileName, { type: "image/png" });
      if (!navigator.canShare({ files: [file] })) { setError("This browser can't share files. Download the PNG instead."); return; }
      await navigator.share({ files: [file], title: "Our weekly meal plan" });
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === "AbortError")) setError("The meal plan couldn't be shared.");
    }
  }
  return <>
    <h2>Share this week</h2>
    <p className="muted">Send this picture to your household. They don't need an account. It's a snapshot, so later changes won't show.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    <div className="action-row">
      <Button className="button" disabled={!url} onClick={() => void share()}>Share card</Button>
      {url && <a className="button secondary" href={url} download={fileName}>Download PNG</a>}
    </div>
    {url && <img className="share-preview" src={url} alt={`Meal plan for ${weekLabel(week.week)}. ${week.meals.map((meal) => `${DAYS[meal.day]}: ${"recipe" in meal ? meal.recipe.title : meal.title}`).join(". ")}`} />}
  </>;
}

function ShareShopping({ week, items: shoppingItems, notify }: { week: Week; items: Ingredient[]; notify: (message: string, error?: boolean) => void }) {
  const items = useMemo(() => shoppingText(shoppingItems, true).split("\n").filter(Boolean), [shoppingItems]);
  const date = weekLabel(week.week);
  const text = `Woolworths shopping list — ${date}\n\n${items.length ? items.join("\n") : "No ingredients on this list."}`;
  const [url, setUrl] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const objectUrl = useRef("");
  useEffect(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    const list = items.length ? items : ["No ingredients on this list."];
    context.font = "30px sans-serif";
    const wrapped = list.map((item) => {
      const lines: string[] = [];
      let line = "";
      for (const word of item.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (context.measureText(next).width > 900 && line) { lines.push(line); line = word; }
        else line = next;
      }
      if (line) lines.push(line);
      return lines;
    });
    canvas.width = 1080;
    canvas.height = 340 + wrapped.reduce((total, lines) => total + Math.max(1, lines.length) * 56 + 18, 0);
    context.fillStyle = "#f4f6f5"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#1b3fa0"; context.fillRect(0, 0, canvas.width, 240);
    context.fillStyle = "#fff"; context.font = "700 56px sans-serif"; context.fillText("Woolworths shopping list", 60, 100);
    context.font = "30px sans-serif"; context.fillText(date, 60, 160);
    context.fillStyle = "#131c3a";
    let y = 310;
    wrapped.forEach((lines, index) => {
      context.fillStyle = "#1b3fa0"; context.font = "700 26px sans-serif"; context.fillText(`${index + 1}.`, 60, y);
      context.fillStyle = "#131c3a"; context.font = "30px sans-serif";
      lines.forEach((line, lineIndex) => context.fillText(line, 120, y + lineIndex * 56));
      y += Math.max(1, lines.length) * 56 + 18;
      if (index < wrapped.length - 1) { context.fillStyle = "#d3d9e4"; context.fillRect(120, y - 10, 890, 2); }
    });
    let disposed = false;
    canvas.toBlob((blob) => {
      if (disposed || !blob) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      setUrl(objectUrl.current);
    }, "image/png");
    return () => {
      disposed = true;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = "";
    };
  }, [date, items]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Shopping list copied. Paste it into a message to share.");
    } catch (error) {
      console.error("Clipboard access failed:", error);
      setCopyStatus("Automatic copy failed. The text is selected so you can copy it manually.");
      document.querySelector<HTMLTextAreaElement>(".shopping-share-text")?.select();
    }
  }
  async function shareImage() {
    if (!url) return;
    try {
      const file = new File([await (await fetch(url)).blob()], `woolworths-shopping-list-${week.week}.png`, { type: "image/png" });
      if (!navigator.canShare?.({ files: [file] })) { notify("This browser can't share images. Download the PNG instead.", true); return; }
      await navigator.share({ files: [file], title: "Woolworths shopping list" });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) notify("The shopping list image couldn't be shared.", true);
    }
  }
  async function shareText() {
    if (!navigator.share) { await copy(); return; }
    try { await navigator.share({ title: "Woolworths shopping list", text }); }
    catch (error) {
      if (error instanceof Error && error.name !== "AbortError") notify("The shopping list couldn't be shared.", true);
    }
  }
  return <>
    <h2>Share shopping list</h2>
    <p className="muted">Share the current Woolworths ingredients as text or an image. This is a snapshot; later list changes won't be included.</p>
    <div className="action-row">
      <Button className="button" onClick={() => void shareText()}>Share as text</Button>
      <Button className="button secondary" onClick={() => void copy()}>Copy text</Button>
      <Button className="button secondary" disabled={!url} onClick={() => void shareImage()}>Share image</Button>
      {url && <a className="button secondary" href={url} download={`woolworths-shopping-list-${week.week}.png`}>Download PNG</a>}
    </div>
    <p className="muted" role="status">{copyStatus}</p>
    <Textarea classNames={{ input: "shopping-share-text" }} rows={8} value={text} readOnly aria-label="Shopping list text to share" />
    {url && <img className="share-preview" src={url} alt={`Woolworths shopping list for ${date}. ${items.join(". ") || "No ingredients."}`} />}
  </>;
}

function SwapPicker({ week, day, onChoose }: { week: Week; day: number; onChoose: (id?: string) => Promise<void> }) {
  const [alternatives, setAlternatives] = useState<Recipe[]>([]);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    let active = true;
    void api<Recipe[]>(`/weeks/${week.week}/alternatives/${day}`).then((result) => {
      if (active) setAlternatives(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Couldn't load alternatives.");
    });
    return () => { active = false; };
  }, [week.week, day]);
  async function choose(recipeId?: string) {
    setChoosing(true);
    setError("");
    try { await onChoose(recipeId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The dinner couldn't be swapped."); }
    finally { setChoosing(false); }
  }
  return <>
    <h2>Swap {DAYS[day]}'s dinner</h2>
    <p className="muted">Every option follows this week's recipe source, diet, time and protein rules.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {alternatives.length > 0 && <Button className="button secondary" disabled={choosing} onClick={() => void choose()}>Pick one for me</Button>}
    {!alternatives.length && !error && <p className="notice">No other recipe fits this week's rules. Change the planning rules or add a recipe.</p>}
    <div className="swap-list">{alternatives.map((recipe) =>
      <button key={recipe.id} type="button" className="swap-choice" disabled={choosing} onClick={() => void choose(recipe.id)}>
        <img src={recipe.image} alt="" loading="lazy" />
        <div><strong>{recipe.title}</strong><p>{PROTEINS[recipe.protein]}, {recipe.prepMinutes + recipe.cookMinutes} min</p></div>
      </button>)}</div>
  </>;
}

function CustomPlanEditor({ week, day, onSaved }: { week: Week; day: number; onSaved: (week: Week) => void }) {
  const existing = week.meals.find((meal) => meal.day === day);
  const [title, setTitle] = useState(existing && "type" in existing ? existing.title : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      onSaved(await api<Week>(`/weeks/${week.week}/custom`, { day, title, revision: week.revision }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The plan couldn't be saved.");
    } finally { setSaving(false); }
  }
  return <>
    <h2>{existing && "type" in existing ? "Edit your plan" : "Add a plan"}</h2>
    <p className="muted">Add anything you want to remember for this night. It won't add ingredients to your shopping list.</p>
    <form className="custom-plan-form" onSubmit={(event) => void save(event)}>
      <Field label="What's planned?" help="For example: Eating out at Thai, leftovers, or dinner with friends.">
        <TextInput value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={120} required autoFocus
          placeholder="Eating out at Thai" />
      </Field>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="form-bottom"><Button className="button" type="submit" disabled={saving || !title.trim()}>
        {saving ? "Saving..." : "Save plan"}
      </Button></div>
    </form>
  </>;
}

function RecipesPage({ recipes, route, user, onRoute }: {
  recipes: Recipe[];
  route: Route;
  user?: User;
  onRoute: (route: AppRoute, replace?: boolean) => void;
}) {
  const initialRoute = route as { q?: string | null; category?: string | null; protein?: string | null; scope?: string | null };
  const [query, setQuery] = useState(initialRoute.q ?? "");
  const [category, setCategory] = useState(initialRoute.category ?? "all");
  const [protein, setProtein] = useState(initialRoute.protein ?? "all");
  const [scope, setScope] = useState<RecipeScope>((initialRoute.scope as RecipeScope) ?? "starter-and-household");
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem("eatplanner.app:recipe-layout") === "compact"; }
    catch (error) { console.error("Recipe layout preference could not be loaded:", error); return false; }
  });
  const [displayRecipes, setDisplayRecipes] = useState(recipes);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (scope === "starter-and-household") { setDisplayRecipes(recipes); return; }
    if (scope === "household") { setDisplayRecipes(recipes.filter((recipe) => recipe.source === "personal")); return; }
    setLoading(true);
    setLoadError("");
    void api<Recipe[]>(`/recipes?scope=${encodeURIComponent(scope)}`).then((result) => {
      if (active) setDisplayRecipes(result);
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "Couldn't load these recipes.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope, recipes, reload]);
  const filtered = displayRecipes.filter((recipe) =>
    (category === "all" || category === recipe.category) &&
    (protein === "all" || protein === recipe.protein) &&
    `${recipe.title} ${recipe.description} ${recipe.ingredients.map((item) => item.name).join(" ")}`.toLowerCase().includes(query.toLowerCase().trim()));
  function updateRoute(next: Partial<{ q: string; category: string; protein: string; scope: RecipeScope }>) {
    onRoute({ view: "recipes",
      q: (next.q ?? query).trim() || undefined,
      category: (next.category ?? category) === "all" ? undefined : next.category ?? category,
      protein: (next.protein ?? protein) === "all" ? undefined : next.protein ?? protein,
      scope: (next.scope ?? scope) === "starter-and-household" ? undefined : next.scope ?? scope,
    }, true);
  }
  function setLayout(value: boolean) {
    setCompact(value);
    try { localStorage.setItem("eatplanner.app:recipe-layout", value ? "compact" : "comfortable"); }
    catch (error) { console.error(error); }
  }
  return <>
    <PageHeading title="Recipes" description="Browse starter recipes, your household's recipes, or recipes shared by other households." />
    <div className="collection-toolbar">
      <TextInput className="collection-search" type="search" placeholder="Search recipes or ingredients" aria-label="Search recipes"
        value={query} onChange={(event) => { setQuery(event.currentTarget.value); updateRoute({ q: event.currentTarget.value }); }} />
      <select aria-label="Recipe source" value={scope} onChange={(event) => {
        const value = event.currentTarget.value as RecipeScope; setScope(value); updateRoute({ scope: value });
      }}>{Object.entries(RECIPE_SCOPES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
      <select aria-label="Filter recipes by category" value={category} onChange={(event) => {
        setCategory(event.currentTarget.value); updateRoute({ category: event.currentTarget.value });
      }}><option value="all">Every category</option>{Object.entries(CATEGORIES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
      <select aria-label="Filter recipes by protein" value={protein} onChange={(event) => {
        setProtein(event.currentTarget.value); updateRoute({ protein: event.currentTarget.value });
      }}><option value="all">Every protein</option>{Object.entries(PROTEINS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
    </div>
    <div className="collection-layout-toggle" role="group" aria-label="Recipe card layout">
      <Button className="collection-layout-option" variant="subtle" aria-pressed={!compact} onClick={() => setLayout(false)}>Comfortable</Button>
      <Button className="collection-layout-option" variant="subtle" aria-pressed={compact} onClick={() => setLayout(true)}>Compact</Button>
    </div>
    <p className="muted" role="status">{loading ? "Finding recipes..." : `${filtered.length} ${filtered.length === 1 ? "recipe" : "recipes"}`}</p>
    {loadError && <p className="notice" role="alert">{loadError} <Button className="text-button" variant="subtle" onClick={() => setReload((value) => value + 1)}>Try again</Button></p>}
    <div className={`collection-grid${compact ? " is-compact" : ""}`}>
      {filtered.map((recipe) => <button key={recipe.id} type="button" className="collection-card"
        onClick={() => onRoute({ view: "recipes", recipe: recipe.id, q: query || undefined,
          category: category === "all" ? undefined : category, protein: protein === "all" ? undefined : protein,
          scope: scope === "starter-and-household" ? undefined : scope })}>
        <div className="collection-image"><img src={recipe.image} alt="" loading="lazy" /></div>
        <div className="meal-copy"><div className="recipe-meta"><span>{CATEGORIES[recipe.category]}</span><span>{recipe.prepMinutes + recipe.cookMinutes} min</span></div>
          <h3>{recipe.title}</h3><p>{recipe.description}</p>
          {recipe.source === "collection" ? <p className="fineprint">Starter recipe</p>
            : user && !canEditRecipe(recipe, user) ? <p className="fineprint">Shared by another household</p> : null}
        </div>
      </button>)}
      {!loading && filtered.length === 0 && <p className="notice">No recipes match. Clear the search or a filter, or add your own.</p>}
    </div>
    <p className="fineprint collection-note">Photos are serving suggestions and may not show the exact recipe. Check ingredient labels for allergens and follow safe food-handling guidance.</p>
  </>;
}

function AdminPage({ user, onModal }: { user?: User; onModal: (modal: ModalState) => void }) {
  const [households, setHouseholds] = useState<Household[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setHouseholds(await api<Household[]>("/admin/households")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't load households."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!user?.isAdmin) return <>
    <PageHeading title="Admin access required" description="Only the super admin can manage households." />
    <Button className="button" onClick={() => window.history.back()}>Back to your planner</Button>
  </>;
  return <>
    <div className="section-bar"><PageHeading title="Households" description="Each household has its own login, recipes and meal plans." />
      <Button className="button" onClick={() => onModal({ kind: "household" })}>Add household</Button></div>
    <p className="notice">Signed in as super admin: {user.name}. Your own planner is unchanged. Manage this login through the server’s .env settings.</p>
    {loading ? <Loader aria-label="Loading households" /> : error ? <p className="notice" role="alert">{error} <Button className="text-button" variant="subtle" onClick={() => void load()}>Try again</Button></p>
      : households.length ? <div className="household-list">{households.map((household) => <div className="household-row" key={household.id}>
        <h3>{household.name}</h3><div className="action-row">
          <Button className="button secondary small" onClick={() => onModal({ kind: "household", household, mode: "name" })}>Change name</Button>
          <Button className="button secondary small" onClick={() => onModal({ kind: "household", household, mode: "password" })}>Reset password</Button>
        </div></div>)}</div>
        : <p className="admin-empty">No additional households yet. Add a household and share its name and password with its members.</p>}
  </>;
}

function HouseholdEditor({ household, mode, onSaved }: {
  household?: Household;
  mode?: "name" | "password";
  onSaved: (message: string) => void;
}) {
  const creating = !household;
  const [name, setName] = useState(household?.name ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const title = creating ? "Add household" : mode === "name" ? "Change household name" : "Reset household password";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const body: { name?: string; password?: string } = {};
      if (creating || mode === "name") body.name = name.trim();
      if (creating || mode === "password") body.password = password;
      await api(creating ? "/admin/households" : `/admin/households/${household.id}`, body, creating ? "POST" : "PATCH");
      onSaved(creating ? "Household added." : mode === "name" ? "Household name saved." : "Household password reset.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The household couldn't be saved."); }
  }
  return <>
    <h2>{title}</h2>
    {household && <p className="lede">{household.name}</p>}
    <form className="household-form" onSubmit={(event) => void submit(event)}>
      {(creating || mode === "name") && <Field label="Household name" help="Members use this name to sign in. Names must be unique.">
        <TextInput name="name" value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={200} autoComplete="off" />
      </Field>}
      {(creating || mode === "password") && <Field label={creating ? "Password" : "New password"} help="At least 6 characters. Share it only with household members.">
        <TextInput name="password" type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)}
          required minLength={6} maxLength={1024} autoComplete="new-password" />
      </Field>}
      {!creating && mode === "password" && <p className="notice">Resetting the password signs out everyone in this household.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      <Button className="button" type="submit">{creating ? "Add household" : mode === "name" ? "Save name" : "Reset password"}</Button>
    </form>
  </>;
}

async function preparePhoto(file: File, signal?: AbortSignal): Promise<string> {
  const isHeic = /^image\/hei[cf](?:-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if ((!file.type.startsWith("image/") && !isHeic) || file.size > 15_000_000) {
    throw new Error(file.size > 15_000_000 ? "Choose a photo smaller than 15 MB." : "Choose an image file.");
  }
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch (error) {
    signal?.throwIfAborted();
    if (!isHeic) {
      console.error(error);
      throw new Error("This photo format couldn't be opened. Try a JPEG, PNG, WebP or HEIC photo.");
    }
    const response = await fetch("/api/recipes/convert-heic", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000),
    });
    if (!response.ok) {
      const result: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
      throw new Error(isRecord(result) && typeof result.error === "string" ? result.error : `Photo conversion failed (${response.status}).`);
    }
    const converted = await response.blob();
    signal?.throwIfAborted();
    try { bitmap = await createImageBitmap(converted); }
    catch (conversionError) {
      signal?.throwIfAborted();
      console.error(conversionError);
      throw new Error("The converted photo couldn't be opened.");
    }
  }
  try {
    signal?.throwIfAborted();
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser cannot prepare this photo.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.88);
    if (data.length > 2_900_000) throw new Error("This photo is still too large. Crop it and try again.");
    return data;
  } finally { bitmap.close(); }
}

async function rotatePhoto(dataUrl: string): Promise<string> {
  const [, encoded] = dataUrl.split(",");
  if (!encoded) throw new Error("This photo couldn't be rotated.");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.height;
    canvas.height = bitmap.width;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser cannot rotate this photo.");
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(bitmap, 0, 0);
    const rotated = canvas.toDataURL("image/jpeg", 0.88);
    if (rotated.length > 2_900_000) throw new Error("This rotated photo is too large. Choose a smaller image.");
    return rotated;
  } finally { bitmap.close(); }
}

function PhotoPicker({ disabled, onFiles, multiple = false }: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  multiple?: boolean;
}) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  }
  return <div className="photo-picker">
    <input ref={cameraInput} type="file" accept="image/*,.heic,.heif" capture="environment"
      disabled={disabled} onChange={handleChange} />
    <input ref={libraryInput} type="file" accept="image/*,.heic,.heif" multiple={multiple}
      disabled={disabled} onChange={handleChange} />
    <Group gap="sm" grow wrap="nowrap" className="photo-picker-actions">
      <Button type="button" disabled={disabled} onClick={() => cameraInput.current?.click()}>Take a photo</Button>
      <Button type="button" variant="default" disabled={disabled} onClick={() => libraryInput.current?.click()}>
        Choose from library
      </Button>
    </Group>
  </div>;
}

function RecipeEditor({ recipe, onSaved, notify }: {
  recipe?: Recipe;
  onSaved: (recipe: Recipe) => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [title, setTitle] = useState(recipe?.title ?? "");
  const [description, setDescription] = useState(recipe?.description ?? "");
  const [category, setCategory] = useState<Recipe["category"]>(recipe?.category ?? "quick");
  const [protein, setProtein] = useState<Recipe["protein"]>(recipe?.protein ?? "chicken");
  const [diet, setDiet] = useState<Recipe["diet"]>(recipe?.diet ?? "omnivore");
  const [servings, setServings] = useState<number | string>(recipe?.servings ?? 2);
  const [prepMinutes, setPrepMinutes] = useState<number | string>(recipe?.prepMinutes ?? 10);
  const [cookMinutes, setCookMinutes] = useState<number | string>(recipe?.cookMinutes ?? 20);
  const [ingredients, setIngredients] = useState(recipe?.ingredients.map((item) =>
    `${item.quantity} | ${item.unit} | ${item.name}${item.pantry ? " | pantry" : ""}`).join("\n") ?? "");
  const [steps, setSteps] = useState(recipe?.steps.join("\n") ?? "");
  const [notes, setNotes] = useState(recipe?.notes ?? "");
  const [image, setImage] = useState(recipe?.image ?? "/images/pasta.jpg");
  const [imageCredit, setImageCredit] = useState<ImageCredit | undefined>(recipe?.imageCredit);
  const [reviewed, setReviewed] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [recipePagePreviews, setRecipePagePreviews] = useState<string[]>([]);
  const readingController = useRef<AbortController | null>(null);
  const [excludedPhotoSources, setExcludedPhotoSources] = useState<string[]>(recipe?.imageCredit?.sourceUrl ? [recipe.imageCredit.sourceUrl] : []);
  const recipeInput = useMemo(() => ({ title, description, category, protein, diet, servings: Number(servings),
    prepMinutes: Number(prepMinutes), cookMinutes: Number(cookMinutes), ingredients, steps, notes }), [
    title, description, category, protein, diet, servings, prepMinutes, cookMinutes, ingredients, steps, notes,
  ]);
  async function addRecipePages(files: File[]) {
    if (!files.length) return;
    if (recipePagePreviews.length + files.length > 4) {
      const message = "Choose up to 4 recipe-page photos.";
      setError(message);
      notify(message, true);
      return;
    }
    setBusy(true);
    setError("");
    setStatus("Preparing recipe photos...");
    try {
      const prepared: string[] = [];
      for (const file of files) prepared.push(await preparePhoto(file));
      const combinedSize = [...recipePagePreviews, ...prepared].reduce((total, photo) => total + photo.length, 0);
      if (combinedSize > 3_700_000) throw new Error("Choose smaller photos or use fewer images (up to 4).");
      setRecipePagePreviews((current) => [...current, ...prepared]);
      setStatus(`${recipePagePreviews.length + prepared.length} recipe photo${recipePagePreviews.length + prepared.length === 1 ? "" : "s"} ready. Rotate any image if needed, then read the recipe.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Couldn't prepare these photos.";
      setError(message);
      setStatus("Couldn't prepare the recipe photos. Choose another image or enter the recipe below.");
      notify(message, true);
    } finally { setBusy(false); }
  }
  async function rotateRecipePage(index: number) {
    setBusy(true);
    setError("");
    try {
      const rotated = await rotatePhoto(recipePagePreviews[index]);
      setRecipePagePreviews((current) => current.map((photo, at) => at === index ? rotated : photo));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Couldn't rotate this photo.";
      setError(message);
      notify(message, true);
    } finally { setBusy(false); }
  }
  async function importRecipe() {
    if (!recipePagePreviews.length) return;
    const controller = new AbortController();
    readingController.current = controller;
    setBusy(true);
    setError("");
    setWarnings([]);
    try {
      setStatus(`Reading ${recipePagePreviews.length} recipe photo${recipePagePreviews.length === 1 ? "" : "s"} with Copilot. This can take up to two minutes.`);
      const result = await api<{
        recipe: (Omit<Recipe, "id" | "source" | "householdId" | "image" | "ingredients"> & {
          ingredients: Array<Omit<Ingredient, "quantity" | "unit"> & { quantity: number | null; unit: string | null }>;
        }) | null;
        warnings: string[];
      }>(
        "/recipes/extract", {
          photos: recipePagePreviews.map((photo) => ({ data: photo.split(",")[1], mimeType: "image/jpeg" })),
        }, undefined, controller.signal);
      controller.signal.throwIfAborted();
      if (!result.recipe) throw new Error(result.warnings.join(" ") || "No readable recipe was found. Try a clearer photo.");
      const imported = result.recipe;
      setTitle(imported.title);
      setDescription(imported.description);
      setCategory(imported.category);
      setProtein(imported.protein);
      setDiet(imported.diet);
      setServings(imported.servings);
      setPrepMinutes(imported.prepMinutes);
      setCookMinutes(imported.cookMinutes);
      setIngredients(imported.ingredients.map((item) =>
        `${item.quantity ?? ""} | ${item.unit ?? ""} | ${item.name}${item.pantry ? " | pantry" : ""}`).join("\n"));
      setSteps(imported.steps.join("\n"));
      setNotes(imported.notes);
      setReviewed(false);
      setWarnings(result.warnings);
      setStatus(`Draft ready: ${imported.title}. Review the details below, then save.`);
    } catch (reason) {
      if (controller.signal.aborted) {
        setStatus("Reading cancelled. Choose another photo or enter the recipe below.");
        return;
      }
      const message = reason instanceof Error ? reason.message : "Couldn't read this photo.";
      setError(message);
      setStatus("Couldn't read these photos. Try another image or enter the recipe below.");
      notify(message, true);
    } finally {
      if (readingController.current === controller) readingController.current = null;
      setBusy(false);
    }
  }
  async function chooseDishPhoto(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    setStatus("Preparing dish photo...");
    try {
      setImage(await preparePhoto(file));
      setImageCredit(undefined);
      setStatus("Dish photo ready. It will be saved with this recipe.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Couldn't prepare the dish photo.";
      setError(message);
      notify(message, true);
    } finally { setBusy(false); }
  }
  async function rotateDishPhoto() {
    setBusy(true);
    setError("");
    try {
      setImage(await rotatePhoto(image));
      setImageCredit(undefined);
      setStatus("Dish photo rotated. It will be saved with this recipe.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Couldn't rotate this photo.";
      setError(message);
      notify(message, true);
    } finally { setBusy(false); }
  }
  async function searchImage() {
    setBusy(true);
    setError("");
    setStatus("Searching and checking food photos. This can take up to two minutes...");
    try {
      const result = await api<{ image: string; imageCredit: ImageCredit }>("/recipes/find-image", {
        title, description, protein,
        ingredients: ingredients.split("\n").map((line) => line.split("|")[2]?.trim()).filter(Boolean),
        excludeSourceUrls: excludedPhotoSources.slice(-20),
      });
      setImage(result.image);
      setImageCredit(result.imageCredit);
      setExcludedPhotoSources((current) => [...current, result.imageCredit.sourceUrl].slice(-20));
      setStatus("Photo found. It will be saved with this recipe.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Photo search failed.";
      setError(message);
      setStatus("Photo search failed. Your current image is unchanged.");
      notify(message, true);
    } finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const content = {
        title: recipeInput.title, description: recipeInput.description, category, protein, diet,
        servings: Number(servings), prepMinutes: Number(prepMinutes), cookMinutes: Number(cookMinutes),
        ingredients: parseIngredientLines(ingredients), steps: steps.split("\n").map((line) => line.trim()).filter(Boolean),
        notes, image, ...(imageCredit ? { imageCredit } : {}),
      };
      const saved = await api<Recipe>(recipe ? `/recipes/${encodeURIComponent(recipe.id)}` : "/recipes", content, recipe ? "PUT" : undefined);
      onSaved(saved);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The recipe couldn't be saved.";
      setError(message);
      notify(message, true);
    }
  }
  return <>
    <h2>{recipe ? `Edit ${recipe.title}` : "Add a recipe"}</h2>
    {!recipe && <p className="muted">Other signed-in households can find recipes you add.</p>}
    <form className="recipe-form" onSubmit={(event) => void save(event)}>
      <div className="recipe-photo-options">
        <Paper component="section" className="upload-box" withBorder shadow="xs" radius="lg" p="lg"><h3>Recipe page</h3>
          <p className="muted">Select a photo of the ingredients and method to start reading with Copilot, or enter them manually below.</p>
          <PhotoPicker disabled={busy} multiple onFiles={(files) => { void addRecipePages(files); }} />
          <p className="muted upload-status" role="status">{status}</p>
          {readingController.current && <Button className="button secondary" type="button" onClick={() => readingController.current?.abort()}>Cancel reading</Button>}
          {recipePagePreviews.map((preview, index) => <div className="recipe-page-preview" key={index}>
            <img className="upload-preview" src={preview} alt={`Recipe page ${index + 1}`} />
            <Group gap="xs">
              <Button className="button secondary" type="button" disabled={busy}
                aria-label={`Rotate recipe page ${index + 1} clockwise`} onClick={() => void rotateRecipePage(index)}>Rotate 90°</Button>
              <Button className="button secondary" type="button" disabled={busy}
                aria-label={`Remove recipe page ${index + 1}`} onClick={() => {
                  setRecipePagePreviews((current) => current.filter((_photo, at) => at !== index));
                  setStatus("Recipe photo removed.");
                }}>Remove</Button>
            </Group>
          </div>)}
          <Button className="button secondary" type="button" disabled={busy || recipePagePreviews.length === 0}
            onClick={() => void importRecipe()}>Read recipe{recipePagePreviews.length > 1 ? " pages" : ""}</Button>
        </Paper>
        <Paper component="section" className="upload-box" withBorder shadow="xs" radius="lg" p="lg"><h3>Dish photo</h3>
          <p className="muted">Choose an image or take a photo of the finished dish. This is separate from the recipe page.</p>
          <PhotoPicker disabled={busy} onFiles={(files) => { void chooseDishPhoto(files[0]); }} />
          <img className="upload-preview" src={image} alt="Recipe cover photo" />
          {image.startsWith("data:image/") && <Button className="button secondary" type="button" disabled={busy}
            onClick={() => void rotateDishPhoto()}>Rotate dish photo 90°</Button>}
          {imageCredit && <p className="fineprint photo-credit">Photo by {imageCredit.creator} ({imageCredit.license})</p>}
          <Button className="button secondary" type="button" disabled={busy} onClick={() => void searchImage()}>Find a photo with Copilot</Button>
        </Paper>
      </div>
      <p className="fineprint recipe-photo-note">Reading recipe photos or finding a dish photo uses GitHub Copilot and your allowance. You can upload up to 4 recipe-card photos. Images are resized locally. Only import recipes you have permission to use.</p>
      {warnings.length > 0 && <div className="import-warnings" role="status"><strong>Review before saving</strong>
        <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        <p>Compare quantities, units, dietary labels and method with your photo before saving.</p>
      </div>}
      {error && <p className="notice" role="alert">{error}</p>}
      <Field label="Recipe name"><TextInput value={title} onChange={(event) => setTitle(event.currentTarget.value)} required maxLength={100} /></Field>
      <Field label="Description"><Textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} required maxLength={400} rows={2} /></Field>
      <div className="form-grid">
        <Field label="Category"><select value={category} onChange={(event) => setCategory(event.currentTarget.value as Recipe["category"])}>{Object.entries(CATEGORIES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
        <Field label="Primary protein"><select value={protein} onChange={(event) => setProtein(event.currentTarget.value as Recipe["protein"])}>{Object.entries(PROTEINS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
        <Field label="Diet"><select value={diet} onChange={(event) => setDiet(event.currentTarget.value as Recipe["diet"])}>{["omnivore", "vegetarian", "vegan", "pescatarian"].map((item) => <option key={item}>{item}</option>)}</select></Field>
      </div>
      <div className="form-grid">
        <Field label="Servings"><NumberInput value={servings} onChange={setServings} min={1} max={12} required /></Field>
        <Field label="Prep minutes"><NumberInput value={prepMinutes} onChange={setPrepMinutes} min={0} max={180} required /></Field>
        <Field label="Cook minutes"><NumberInput value={cookMinutes} onChange={setCookMinutes} min={0} max={360} required /></Field>
      </div>
      <Field label="Ingredients" help="One per line: quantity | unit | name. Fill any blank quantity or unit before saving. Optionally add | pantry. Units: g, kg, ml, l, tsp, tbsp, piece, pinch. Australian tbsp = 20 ml; tsp = 5 ml.">
        <Textarea value={ingredients} onChange={(event) => setIngredients(event.currentTarget.value)} required rows={6}
          placeholder={"400 | g | canned chickpeas\n1 | piece | lemon\n1 | tbsp | olive oil | pantry"} />
      </Field>
      <Field label="Method" help="One complete step per line."><Textarea value={steps} onChange={(event) => setSteps(event.currentTarget.value)} required rows={6} /></Field>
      <Field label="Notes and source"><Textarea value={notes} onChange={(event) => setNotes(event.currentTarget.value)} maxLength={1500} rows={2} /></Field>
      <label className="check-field"><Checkbox checked={reviewed} onChange={(event) => setReviewed(event.currentTarget.checked)} required />
        <span>I've checked the amounts, dietary labels and steps against the original.</span></label>
      <div className="form-bottom"><span className="muted">{recipe ? "This replaces the saved recipe." : "Saved to this household's recipe file."}</span>
        <Button className="button" type="submit" disabled={busy || !reviewed}>{recipe ? "Update this recipe" : "Save to my collection"}</Button>
      </div>
    </form>
  </>;
}

function ProfilePicker({ notify, onSelected }: {
  notify: (message: string, error?: boolean) => void;
  onSelected: () => Promise<Session>;
}) {
  const [profiles, setProfiles] = useState<HouseholdProfile[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api<HouseholdProfile[]>("/profiles").then((items) => {
      if (active) setProfiles(items);
    }).catch((error) => notify(error instanceof Error ? error.message : "Couldn't load profiles.", true))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notify]);
  const select = async (profile: HouseholdProfile) => {
    setBusy(true);
    try {
      await api("/profiles/select", { id: profile.id });
      await onSelected();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't choose this profile.", true);
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    try {
      await api("/profiles", { name: value });
      await onSelected();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't create this profile.", true);
    } finally {
      setBusy(false);
    }
  };
  return <div className="profile-picker">
    <PageHeading title="Who is using eatplanner?" description="Choose your profile so shopping list items can be attributed to you." />
    {loading ? <Loading message="Finding profiles..." /> : <>
      {profiles.length > 0 && <div className="profile-list">
        {profiles.map((profile) =>
          <Button key={profile.id} className="profile-button" type="button" disabled={busy}
            onClick={() => void select(profile)}>{profile.name}</Button>)}
      </div>}
      <form className="profile-create" onSubmit={(event) => void create(event)}>
        <TextInput label={profiles.length ? "Or add a profile" : "Your name"} value={name} maxLength={200}
          autoComplete="name" disabled={busy} onChange={(event) => setName(event.currentTarget.value)} />
        <Button className="button" type="submit" disabled={!name.trim() || busy}>
          {profiles.length ? "Create profile" : "Create my profile"}
        </Button>
      </form>
    </>}
  </div>;
}

function Login({ notify, theme, setTheme }: {
  notify: (message: string, error?: boolean) => void;
  theme?: "system" | "light" | "dark";
  setTheme?: (value: "system" | "light" | "dark") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [appearance, setAppearance] = useState<"system" | "light" | "dark">(theme ?? "system");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const fields = new FormData(event.currentTarget);
      const result = await api("/auth/login", {
        username: fields.get("username"),
        password: fields.get("password"),
      });
      const next = new URLSearchParams(window.location.search).get("next") ?? "/";
      const destination = new URL(next, window.location.origin);
      window.location.assign(destination.origin === window.location.origin ? destination.href : "/");
      void result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Couldn't sign in. Check your connection.";
      setError(message);
      notify(message, true);
    } finally { setBusy(false); }
  }
  return <div className="login-page">
    <div className="planner-preview" aria-hidden="true">
      <img src="/login-preview.svg" alt="" width="1440" height="1000" />
      <span className="preview-caption">An example week on eatplanner</span>
    </div>
    <main>
      <a className="brand" href="/"><img src="/favicon.svg" alt="" width="64" height="64" />eatplanner<span>.app</span></a>
      <h1>Sign in</h1>
      <p>Use your household or super admin login.</p>
      <form onSubmit={(event) => void submit(event)}>
        <TextInput classNames={{ root: "field", label: "field-label" }} label="Login name" name="username"
          autoComplete="username" required maxLength={200} disabled={busy} />
        <TextInput classNames={{ root: "field", label: "field-label" }} label="Password" name="password"
          type="password" autoComplete="current-password" required maxLength={1024} disabled={busy} />
        {error && <p id="login-error" role="alert">{error}</p>}
        <Button className="button" type="submit" fullWidth disabled={busy}>{busy ? "Signing in..." : "Sign in"}</Button>
      </form>
      {setTheme && <label className="theme-picker">Appearance
        <select value={appearance} onChange={(event) => {
          const value = event.currentTarget.value as "system" | "light" | "dark";
          setAppearance(value);
          setTheme(value);
        }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
      </label>}
    </main>
  </div>;
}

function WeeksPage({ summaries, recipeCount, onWeek, onPlan }: {
  summaries: Summary[];
  recipeCount: number;
  onWeek: (key: string) => void;
  onPlan: (key: string) => void;
}) {
  const current = mondayFor(today());
  const now = today();
  const thisWeek = summaries.find((item) => item.week === current);
  const keys = new Set(summaries.map((item) => item.week));
  for (let offset = -2; offset <= 4; offset++) keys.add(addDays(current, offset * 7));
  keys.delete(current);
  const upcoming = [...keys].filter((key) => key > current).sort();
  const earlier = [...keys].filter((key) => key < current).sort().reverse();
  const weekRow = (key: string) => {
    const saved = summaries.find((item) => item.week === key);
    const name = key === addDays(current, 7) ? "Next week" : key === addDays(current, -7) ? "Last week" : null;
    return <button className={`week-card${saved ? "" : " is-open"}`} key={key} type="button" onClick={() => onWeek(key)}>
      <span className="week-label">{name ?? weekLabel(key)}</span>
      {name && <span className="week-date">{weekLabel(key)}</span>}
      <span className="mini-days" aria-hidden="true">{DAYS.map((day, index) =>
        <span className={saved?.days.includes(index) ? "filled" : ""} key={day}>{day[0]}</span>)}</span>
      <span className="week-preview">{saved ? `${countDinners(saved.count)}: ${saved.titles.join(", ")}` : "Nothing planned"}</span>
      <span className="week-status">{saved ? <Tag tone={saved.status === "confirmed" ? "green" : "draft"}>{saved.status === "confirmed" ? "Locked in" : "Draft"}</Tag> : "Plan"}</span>
    </button>;
  };
  return <>
    <section className="this-week">
      <div className="this-week-head">
        <PageHeading title="This week" description={thisWeek
          ? `${countDinners(thisWeek.count)}, ${weekLabel(current)}. ${thisWeek.status === "confirmed" ? "Locked in." : "Still a draft."}`
          : `${weekLabel(current)}. Nothing planned yet.`} />
        <div className="this-week-actions">
          {!thisWeek && <p className="muted">Pick the nights. Dinners come from your {recipeCount} recipes.</p>}
          <Button className="button" onClick={() => onPlan(current)}>{thisWeek ? "Open this week" : "Plan this week"}</Button>
        </div>
      </div>
      <ol className="week-strip is-entering">{DAYS.map((day, index) => {
        const key = addDays(current, index);
        const meal = thisWeek?.days.indexOf(index) ?? -1;
        return <li className={`strip-cell${meal >= 0 ? " filled" : ""}${key === now ? " is-today" : ""}${key < now ? " is-past" : ""}`} key={day}>
          <div className="strip-day"><strong>{day.slice(0, 3)}</strong><span>{dateLabel(key, { day: "numeric" })}</span>
            {key === now && <span className="strip-today">Today</span>}</div>
          {meal >= 0 && thisWeek ? <button className="strip-meal" type="button" onClick={() => onWeek(current)}>
            {thisWeek.images?.[meal] && <img src={thisWeek.images[meal]} alt="" loading="lazy" />}
            <span>{thisWeek.titles[meal]}</span>
          </button> : thisWeek ? <span className="strip-empty">Night off</span> : null}
        </li>;
      })}</ol>
    </section>
    <section className="weeks-section">
      <div className="section-bar"><h2>Coming up</h2>
        <Field label="Jump to a week"><input type="date" aria-label="Choose any date in a week"
          onChange={(event) => event.currentTarget.value && onWeek(mondayFor(event.currentTarget.value))} /></Field>
      </div>
      <div className="week-list">{upcoming.map(weekRow)}</div>
      <h3>Earlier</h3><div className="week-list">{earlier.map(weekRow)}</div>
    </section>
  </>;
}

function WeekPage({ week, weekKey, user, onWeek, onRoute, onModal, notify, run, changeShopping, shopping }: {
  week: Week | null;
  weekKey: string;
  user?: User;
  onWeek: (week: Week) => void;
  onRoute: (route: AppRoute, replace?: boolean) => void;
  onModal: (modal: ModalState) => void;
  notify: (message: string, error?: boolean) => void;
  run: (action: () => Promise<void>, control?: HTMLButtonElement | null) => Promise<void>;
  changeShopping: (path: string, body: unknown, method?: string) => Promise<void>;
  shopping: HouseholdShopping | null;
}) {
  const locked = week?.status === "confirmed";
  const navigateBack = () => onRoute({ view: "weeks" });

  async function mutate(action: string, body: Record<string, unknown> = {}) {
    const updated = await api<Week>(`/weeks/${weekKey}/${action}`, { ...body, revision: week?.revision });
    onWeek(updated);
    return updated;
  }
  const moveControl = (meal: Meal, index: number) => <select aria-label={`Change day for ${"recipe" in meal ? meal.recipe.title : meal.title}`}
    value={index} onChange={(event) => {
      const control = event.currentTarget;
      void run(async () => {
        try {
          await mutate("move", { from: index, to: Number(control.value) });
          notify("Dinner moved. Two dinners trade places when both nights are taken.");
        } finally { control.value = String(index); }
      });
    }}>{DAYS.map((name, dayIndex) => <option value={dayIndex} key={name}>Move to {name}</option>)}</select>;

  if (!week) return <>
    <div className="action-row"><Button className="text-button" variant="subtle" onClick={navigateBack}>All weeks</Button></div>
    <PageHeading title={weekLabel(weekKey)} description="Choose the nights that need dinner, then set a few rules." />
    <PlanningForm week={null} weekKey={weekKey} onSaved={(updated) => {
      onWeek(updated);
      notify("Draft ready. Swap anything you don't fancy.");
    }} />
  </>;

  const mealFor = (day: number) => week.meals.find((meal) => meal.day === day);
  async function unlock() {
    if (!window.confirm("Unlock this week? Its shopping list is rebuilt when you lock it in again.")) return;
    await mutate("unlock");
    notify("Unlocked. Lock the week in again after your changes.");
  }

  return <>
    <div className="action-row">
      <Button className="text-button" variant="subtle" onClick={navigateBack}>All weeks</Button>
      {week && <Button className="button secondary small" onClick={() => onModal({ kind: "share-week" })}>Share week</Button>}
    </div>
    <PageHeading title={weekLabel(weekKey)} description={`${countDinners(week.meals.length)} for ${peopleLabel(week)}.`} />
    <div className={`plan-status${locked ? " locked" : ""}`}>
      <div><Tag tone={locked ? "green" : "draft"}>{locked ? "Locked in" : "Draft"}</Tag>
        <span>{locked ? "Dinners and shopping quantities are saved for this week." : "Swap a dinner or move it to another night, then lock the week in."}</span></div>
      {locked ? <Button className="text-button" variant="subtle" onClick={() => void run(unlock)}>Unlock to edit</Button>
        : <Button className="text-button" variant="subtle" onClick={() => onModal({ kind: "edit-week", week })}>Change planning rules</Button>}
    </div>
    <div className="meal-grid">{DAYS.map((day, index) => {
      const meal = mealFor(index);
      const date = addDays(weekKey, index);
      return <article className={`day-card${meal ? "" : " day-off"}${date === today() ? " today-card" : ""}`} key={day}>
        <div className="day-card-heading"><strong>{day}</strong><span>{date === today() ? "Today, " : ""}{dateLabel(date)}</span></div>
        {!meal ? <div className="off-content"><div><h3>Night off</h3><p>Leftovers, takeaway, or whatever happens.</p></div>
          {!locked && <Button className="text-button" variant="subtle" onClick={() => onModal({ kind: "custom-plan", day: index })}>Add a plan</Button>}</div>
          : "recipe" in meal
            ? <>
              <button type="button" className="recipe-open" onClick={() => onRoute({ view: "week", week: weekKey, recipe: meal.recipe.id, day: String(index) })}>
                <img src={meal.recipe.image} alt={meal.recipe.title} loading="lazy" className="meal-photo" />
                <div className="meal-copy"><div className="recipe-meta"><Tag>{PROTEINS[meal.recipe.protein]}</Tag><span>{meal.recipe.prepMinutes + meal.recipe.cookMinutes} min</span></div>
                  <h3>{meal.recipe.title}</h3><p>{CATEGORIES[meal.recipe.category]}</p>
                  {meal.cooked ? <span className="tag green meal-completion">Cooked</span> : <span className="card-link">{locked ? "Let's cook" : "Read recipe"}</span>}
                </div>
              </button>
              {!locked && <div className="meal-actions"><Button className="text-button" variant="subtle" onClick={() => onModal({ kind: "swap", day: index })}>Swap</Button>
                {moveControl(meal, index)}
              </div>}
            </>
            : <>
              <div className="custom-plan"><span className="eyebrow">Custom plan</span><h3>{meal.title}</h3></div>
              {!locked && <div className="meal-actions custom-plan-actions">
                <Button className="text-button" variant="subtle" onClick={() => onModal({ kind: "custom-plan", day: index })}>Edit</Button>
                <Button className="text-button" variant="subtle" onClick={() => void run(async () => {
                  await mutate("remove-custom", { day: index });
                  notify("Custom plan removed.");
                })}>Remove</Button>
                {moveControl(meal, index)}
              </div>}
            </>}
      </article>;
    })}</div>
    {locked ? <ShoppingPanel week={week} user={user} notify={notify} changeShopping={changeShopping} shopping={shopping}
      onShare={(includePantry, haveItems) => onModal({
        kind: "share-shopping",
        week,
        items: week.shoppingList.filter((item) =>
          (includePantry || !item.pantry) && !haveItems.has(`${item.name}|${item.unit}`)),
      })} /> : <div className="confirm-bar">
      <div><h2>Happy with this week?</h2><p>Lock it in to build one shopping list for all of it.</p></div>
      <Button className="button" onClick={() => void run(async () => {
        const updated = await mutate("confirm");
        notify("Locked in. Your shopping list is ready.");
        window.setTimeout(() => document.querySelector("#shopping")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      })}>Lock in this week</Button>
    </div>}
  </>;
}
