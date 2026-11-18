const form = document.querySelector("#login");
const errorMessage = document.querySelector("#login-error");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button");
  submit.disabled = true;
  errorMessage.hidden = true;
  try {
    const fields = new FormData(form);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: fields.get("username"), password: fields.get("password") }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Couldn't sign in. Try again.");
    const next = new URLSearchParams(window.location.search).get("next") ?? "/";
    const destination = new URL(next, window.location.origin);
    window.location.assign(destination.origin === window.location.origin ? destination.href : "/");
  } catch (error) {
    console.error("Sign-in failed:", error);
    errorMessage.textContent = error instanceof Error ? error.message : "Couldn't sign in. Check your connection.";
    errorMessage.hidden = false;
  } finally { submit.disabled = false; }
});
