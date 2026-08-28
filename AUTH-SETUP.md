# Supabase authentication setup

1. Create a Supabase project.
2. In Supabase, open **Authentication → Providers → Email** and keep Email/Password enabled.
3. Create your first user in **Authentication → Users**.
4. Open **Project Settings / API** and copy:
   - Project URL
   - Publishable key (or legacy anon key)
5. Put those values in `config.js`.
6. Do **not** use the `service_role` key in frontend code.
7. Test locally:

   ```bash
   python3 -m http.server 8000
   ```

   Open `http://localhost:8000/login.html`.

8. Commit and push the files. GitHub Pages will deploy them through your existing workflow.

Important: this protects the normal UI/session flow, but GitHub Pages remains static hosting.
Do not put secrets or private data directly inside HTML/JS files.
