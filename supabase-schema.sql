-- Notes de frais URPS — schéma Supabase
-- À coller dans Supabase : Project > SQL Editor > New query > Run

-- ---------- Profils (un par utilisateur) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nom text not null default '',
  adresse1 text not null default '',
  adresse2 text not null default '',
  email text not null default '',
  km_rate numeric not null default 0.697,
  vehicle_type text not null default 'Auto',
  peage_nice_marseille numeric not null default 42.4,
  signature_data_url text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ---------- Dépenses ----------
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  descriptif text not null default '',
  transport numeric not null default 0,
  km numeric not null default 0,
  km_rate numeric not null default 0,
  parking numeric not null default 0,
  hotel numeric not null default 0,
  repas numeric not null default 0,
  divers numeric not null default 0,
  trajet text not null default 'none',
  trajet_rate numeric not null default 0,
  demi_journees numeric not null default 0,
  visio numeric not null default 0,
  forfait_rate numeric not null default 276,
  created_at timestamptz not null default now()
);

alter table public.expenses enable row level security;

create policy "expenses_all_own" on public.expenses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists expenses_user_date_idx on public.expenses (user_id, date desc);

-- ---------- Justificatifs (métadonnées ; les fichiers vont dans Storage) ----------
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  filename text not null default '',
  storage_path text not null,
  mime_type text not null default 'image/jpeg',
  width int not null default 0,
  height int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.receipts enable row level security;

create policy "receipts_all_own" on public.receipts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists receipts_expense_idx on public.receipts (expense_id);

-- ---------- Storage : bucket des justificatifs ----------
-- Chaque fichier est rangé sous le chemin "<user_id>/<nom de fichier>" ;
-- les politiques ci-dessous n'autorisent chacun qu'à lire/écrire son propre dossier.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "receipts_storage_select_own" on storage.objects
  for select using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts_storage_insert_own" on storage.objects
  for insert with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "receipts_storage_delete_own" on storage.objects
  for delete using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
