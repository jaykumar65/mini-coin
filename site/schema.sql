-- MNC टेस्टनेट: blocks टेबल
-- Supabase Dashboard -> SQL Editor में एक बार चलाएँ।
-- साइट इस टेबल को सिर्फ़ पढ़ती है। लिखने की कोई policy नहीं है, इसलिए
-- publishable key से कोई भी इसमें कुछ जोड़/बदल/मिटा नहीं सकता।

create table if not exists public.blocks (
  idx         bigint primary key,           -- ब्लॉक नंबर (0 से)
  prev_hash   text   not null,              -- पिछले ब्लॉक का hash
  hash        text   not null unique,       -- इस ब्लॉक का SHA-256 (hex)
  nonce       bigint not null,
  difficulty  int    not null default 4,    -- hash की शुरुआत में ज़ीरो की संख्या
  ts          bigint not null,              -- समय, मिलीसेकंड में
  data        text   not null default '',
  miner       text   not null default '',   -- किसे इनाम मिला
  reward      numeric not null default 50,  -- MNC (टेस्ट, कोई मूल्य नहीं)
  created_at  timestamptz not null default now()
);

alter table public.blocks enable row level security;

grant select on public.blocks to anon, authenticated;

drop policy if exists "blocks: public read" on public.blocks;
create policy "blocks: public read"
  on public.blocks for select
  to anon, authenticated
  using (true);
