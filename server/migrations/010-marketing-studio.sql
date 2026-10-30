CREATE TABLE marketing_brand_kits (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 primary_color text NOT NULL CHECK(primary_color ~ '^#[0-9A-Fa-f]{6}$'),
 background_color text NOT NULL CHECK(background_color ~ '^#[0-9A-Fa-f]{6}$'),
 text_color text NOT NULL CHECK(text_color ~ '^#[0-9A-Fa-f]{6}$'),
 font_identity text NOT NULL DEFAULT 'Space Grotesk 600 / 400 (Fontsource 5.1.0)',
 logo_asset_id uuid, revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,logo_asset_id) REFERENCES assets(workspace_id,id)
);

CREATE TABLE marketing_products (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 description text NOT NULL DEFAULT '' CHECK(char_length(description) <= 2000),
 image_asset_id uuid NOT NULL, additional_asset_ids uuid[] NOT NULL DEFAULT '{}',
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,image_asset_id) REFERENCES assets(workspace_id,id)
);

CREATE TABLE marketing_briefs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 brand_kit_id uuid NOT NULL, product_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 objective text NOT NULL CHECK(char_length(objective) BETWEEN 1 AND 1000),
 format text NOT NULL CHECK(format IN ('square_1080','portrait_1080x1350','landscape_1920x1080')),
 headline text NOT NULL, body text NOT NULL, cta text NOT NULL,
 variant_count integer NOT NULL CHECK(variant_count BETWEEN 1 AND 6),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,brand_kit_id) REFERENCES marketing_brand_kits(workspace_id,id),
 FOREIGN KEY(workspace_id,product_id) REFERENCES marketing_products(workspace_id,id)
);

CREATE TABLE marketing_variants (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL, brief_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), variant_index integer NOT NULL CHECK(variant_index BETWEEN 0 AND 5),
 snapshot jsonb NOT NULL, recipe_id text NOT NULL, recipe_version text NOT NULL, recipe_sha256 text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','rendering','succeeded','failed')),
 output_asset_id uuid, error text, idempotency_key text NOT NULL, payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,idempotency_key,variant_index),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,brief_id) REFERENCES marketing_briefs(workspace_id,id),
 FOREIGN KEY(workspace_id,output_asset_id) REFERENCES assets(workspace_id,id),
 CHECK((state='succeeded')=(output_asset_id IS NOT NULL)),
 CHECK(state<>'failed' OR error IS NOT NULL)
);

CREATE INDEX marketing_products_project ON marketing_products(workspace_id,project_id,updated_at DESC);
CREATE INDEX marketing_briefs_project ON marketing_briefs(workspace_id,project_id,updated_at DESC);
CREATE INDEX marketing_variants_project ON marketing_variants(workspace_id,project_id,created_at DESC);
CREATE INDEX marketing_variants_recovery ON marketing_variants(state,updated_at);
