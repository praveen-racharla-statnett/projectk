const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

async function login(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (!error && data.session) {
    window.location.replace("index.html");
  }

  return { data, error };
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.replace("login.html");
}

async function protectPage() {
  const { data, error } = await supabaseClient.auth.getSession();

  if (error || !data.session) {
    window.location.replace("login.html");
    return;
  }

  document.documentElement.classList.add("authenticated");
}

async function redirectIfLoggedIn() {
  const { data } = await supabaseClient.auth.getSession();

  if (data.session) {
    window.location.replace("index.html");
  }
}
