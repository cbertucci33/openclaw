import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  emitUserProfilesChanged,
  onUserProfileEmailBindingChanged,
  readUserProfileEmailBindingRevision,
  readUserProfileVersion,
} from "./user-profile-events.js";
import {
  selectResolvedUserProfile,
  selectResolvedUserProfileMetadataById,
  projectUserProfileDisplay,
  userProfileDisplaySelection,
  selectProfileDisplayEntries,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileNotFoundError } from "./user-profiles-schema.js";
import type { ProfileDisplayRow, UserProfileEmailBinding } from "./user-profiles.types.js";

/** Disclosure scopes need current aliases, never the resident display catalog. */
export function readCurrentUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(database.db, () => {
    const canonicalId =
      selectResolvedUserProfileMetadataById(database.db, profileId)?.id ?? profileId;
    const aliases = executeSqliteQuerySync(
      database.db,
      userProfilesDb(database.db)
        .selectFrom("user_profiles")
        .select("id")
        .where("merged_into", "=", canonicalId),
    ).rows;
    return new Set([canonicalId, ...aliases.map((row) => row.id)]);
  });
}

/** True when session-sharing policy can distinguish at least two durable people. */
export function hasMultipleSessionSharingIdentities(
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profiles = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select("id")
      .where("merged_into", "is", null)
      .where("id", "!=", GATEWAY_OWNER_PROFILE_ID)
      .limit(2),
  ).rows;
  return profiles.length >= 2;
}

/** Exact durable identity facts; never use display-reference prefix matching for authority. */
export function readUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return readProfileCatalog(
    options,
    (resident) => {
      const profile = resolveCatalogProfile(resident, profileId);
      return (
        profile && {
          profileId: profile.id,
          role: profile.role ?? null,
          aliases: new Set(
            [...resident.values()]
              .filter((row) => row.id === profile.id || row.merged_into === profile.id)
              .map((row) => row.id),
          ),
        }
      );
    },
    (db) => {
      const profile = selectResolvedUserProfileMetadataById(db, profileId);
      return (
        profile && {
          profileId: profile.id,
          role: profile.role ?? null,
          aliases: new Set(
            executeSqliteQuerySync(
              db,
              userProfilesDb(db)
                .selectFrom("user_profiles")
                .select("id")
                .where((eb) =>
                  eb.or([eb("id", "=", profile.id), eb("merged_into", "=", profile.id)]),
                ),
            ).rows.map((row) => row.id),
          ),
        }
      );
    },
  );
}

/** Existing one-hop aliases are identity facts; this read never creates profile storage. */
export function readUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  return new Set([profileId, ...(readUserProfileIdentity(profileId, options)?.aliases ?? [])]);
}

function resolveCatalogProfile(rows: Map<string, ProfileDisplayRow>, id: string) {
  const raw = rows.get(id);
  return rows.get(raw?.merged_into ?? id) ?? raw;
}

/** Gateway readers already retain this catalog with their session projection. */
export function readResidentUserProfileId(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  const catalog = profileCatalogs.get(profileCatalogPath(options));
  if (!catalog?.valid) {
    throw new Error("User profile catalog is not ready");
  }
  return resolveCatalogProfile(catalog.rows, profileId)?.id;
}
type ProfileCatalog = {
  rows: Map<string, ProfileDisplayRow>;
  identity: DatabasePathIdentity;
  valid: boolean;
  leases: Set<symbol>;
  asyncOnly?: boolean;
};
const profileCatalogs = new Map<string, ProfileCatalog>();
type ProfilePublication = {
  identity: DatabasePathIdentity;
  profileId: string;
  createdEmail?: string;
  bindingSuperseded: boolean;
  witnesses: Map<
    Map<string, ProfileDisplayRow>,
    { row: ProfileDisplayRow | undefined; late: boolean }
  >;
  catalogs: Map<ProfileCatalog, symbol>;
};
const profilePublications = new Set<ProfilePublication>();
let stopCatalogEvents: (() => void) | undefined;
let stopBindingEvents: (() => void) | undefined;
let profileCatalogHandles = new WeakMap<DatabaseSync, Map<string, ProfileDisplayRow>>();
type ProfileBindings = {
  byEmail: Map<string, UserProfileEmailBinding>;
  byId: Map<string, string>;
};
const profileBindings = new WeakMap<Map<string, ProfileDisplayRow>, ProfileBindings>();

function applyEmailBinding(
  bindings: ProfileBindings,
  email: string,
  binding: UserProfileEmailBinding | null,
): string | undefined {
  const previous = bindings.byEmail.get(email);
  if (previous?.bindingId) {
    bindings.byId.delete(previous.bindingId);
  }
  if (binding) {
    bindings.byEmail.set(email, binding);
    if (binding.bindingId) {
      bindings.byId.set(binding.bindingId, binding.profileId);
    }
  } else {
    bindings.byEmail.delete(email);
  }
  return previous?.profileId;
}

function observeEmailBindings(): void {
  stopBindingEvents ??= onUserProfileEmailBindingChanged(({ db, email, binding }) => {
    const rows = profileCatalogHandles.get(db);
    if (rows) {
      for (const publication of profilePublications) {
        if (publication.createdEmail === email && publication.witnesses.has(rows)) {
          publication.bindingSuperseded = true;
        }
      }
    }
    const bindings = rows && profileBindings.get(rows);
    if (!rows || !bindings) {
      return;
    }
    const previous = applyEmailBinding(bindings, email, binding);
    // Both owners' witnesses change even when GitHub enrichment only publishes its target.
    for (const id of new Set([previous, binding?.profileId])) {
      const row = id && rows.get(id);
      if (row) {
        rows.set(row.id, { ...row });
      }
    }
  });
}
const profileCatalogPath = (options: OpenClawStateDatabaseOptions) =>
  path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));

function readProfileCatalog<T>(
  options: OpenClawStateDatabaseOptions,
  resident: (rows: Map<string, ProfileDisplayRow>) => T,
  stored: (db: DatabaseSync) => T,
): T | undefined {
  const catalog = profileCatalogs.get(profileCatalogPath(options));
  return catalog
    ? resident(catalog.rows)
    : withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => (tableExists(db, "user_profiles") ? stored(db) : undefined),
        options,
      );
}

function loadProfileCatalog(
  catalog: ProfileCatalog,
  db: DatabaseSync,
  identity: DatabasePathIdentity,
) {
  if (!catalog.valid || catalog.identity.key !== identity.key) {
    const shared = [...profileCatalogs.values()].find(
      (candidate) => candidate.valid && candidate.identity.key === identity.key,
    );
    catalog.rows =
      shared?.rows ??
      new Map(tableExists(db, "user_profiles") ? selectProfileDisplayEntries(db) : []);
    Object.assign(catalog, { identity, valid: true });
    for (const publication of profilePublications) {
      retainProfilePublicationCatalog(publication, catalog, true);
    }
    return true;
  }
  return false;
}

function retainProfilePublicationCatalog(
  publication: ProfilePublication,
  catalog: ProfileCatalog,
  late: boolean,
) {
  if (!catalog.valid || catalog.identity.key !== publication.identity.key) {
    return;
  }
  if (!publication.catalogs.has(catalog)) {
    const lease = Symbol("pending profile publication");
    publication.catalogs.set(catalog, lease);
    catalog.leases.add(lease);
  }
  if (!publication.witnesses.has(catalog.rows)) {
    publication.witnesses.set(catalog.rows, { row: catalog.rows.get(publication.profileId), late });
  }
}

function releaseProfileCatalog(catalog: ProfileCatalog, lease: symbol) {
  if (catalog.leases.delete(lease) && catalog.leases.size === 0) {
    for (const [pathname, current] of profileCatalogs) {
      if (current === catalog) {
        profileCatalogs.delete(pathname);
      }
    }
  }
  if (profileCatalogs.size === 0) {
    stopCatalogEvents?.();
    stopCatalogEvents = undefined;
    stopBindingEvents?.();
    stopBindingEvents = undefined;
    profileCatalogHandles = new WeakMap();
  }
}

/** Capture under the worker's write transaction; native commits replace these row objects. */
export function retainUserProfilePublication(
  identity: DatabasePathIdentity,
  profileId: string,
  before: ProfileDisplayRow | undefined,
  createdEmail?: string,
) {
  const publication: ProfilePublication = {
    identity,
    profileId,
    createdEmail,
    bindingSuperseded: false,
    witnesses: new Map(),
    catalogs: new Map(),
  };
  profilePublications.add(publication);
  for (const catalog of profileCatalogs.values()) {
    retainProfilePublicationCatalog(publication, catalog, false);
  }
  return {
    reconcile(
      this: void,
      observed: ProfileDisplayRow | undefined,
      emailBindings?: readonly UserProfileEmailBinding[],
    ) {
      let changed = false;
      for (const catalog of publication.catalogs.keys()) {
        const witness = publication.witnesses.get(catalog.rows);
        if (
          catalog.valid &&
          catalog.identity.key === identity.key &&
          witness &&
          catalog.rows.get(profileId) === witness.row &&
          (!witness.late || isDeepStrictEqual(witness.row, before))
        ) {
          const bindings = profileBindings.get(catalog.rows);
          if (
            bindings &&
            emailBindings &&
            publication.createdEmail !== undefined &&
            !publication.bindingSuperseded
          ) {
            for (const [email, binding] of bindings.byEmail) {
              if (binding.profileId === profileId) {
                applyEmailBinding(bindings, email, null);
              }
            }
            for (const binding of emailBindings) {
              applyEmailBinding(bindings, binding.email, binding);
            }
          }
          if (isDeepStrictEqual(witness.row, observed)) {
            continue;
          }
          if (observed) {
            catalog.rows.set(profileId, observed);
          } else {
            catalog.rows.delete(profileId);
          }
          changed = true;
        }
      }
      if (changed || !isDeepStrictEqual(before, observed)) {
        emitUserProfilesChanged();
      }
    },
    release(this: void) {
      profilePublications.delete(publication);
      for (const [catalog, lease] of publication.catalogs) {
        releaseProfileCatalog(catalog, lease);
      }
      publication.catalogs.clear();
    },
  };
}

function observeProfileCatalogs(refresh = false): void {
  observeEmailBindings();
  if (stopCatalogEvents && !refresh) {
    return;
  }
  stopCatalogEvents?.();
  stopCatalogEvents = registerOpenClawStateDatabaseLifecycleListener((event) => {
    let changed = false;
    for (const [locator, current] of profileCatalogs) {
      if (event.kind === "opened") {
        if (
          event.database.path !== locator &&
          event.identity.key !== current.identity.key &&
          event.identity.canonicalPath !== current.identity.canonicalPath
        ) {
          continue;
        }
        if (current.asyncOnly) {
          if (current.identity.key !== event.identity.key) {
            current.rows = new Map();
            current.identity = event.identity;
            current.valid = false;
            changed = true;
          }
        } else {
          changed = loadProfileCatalog(current, event.database.db, event.identity) || changed;
        }
        profileCatalogHandles.set(event.database.db, current.rows);
      } else if (
        event.kind !== "closed" &&
        (event.path === locator || event.identity?.key === current.identity.key)
      ) {
        current.rows.clear();
        current.valid = false;
        changed = true;
      }
    }
    if (changed) {
      emitUserProfilesChanged();
    }
  });
}

/** Retain exact identity and display/navigation facts; physical admission updates every locator before observers. */
export function retainUserProfileCatalog(options: OpenClawStateDatabaseOptions = {}): () => void {
  const pathname = profileCatalogPath(options);
  const catalog: ProfileCatalog = profileCatalogs.get(pathname) ?? {
    rows: new Map(),
    identity: readDatabasePathIdentitySync(pathname),
    valid: false,
    leases: new Set<symbol>(),
  };
  if (!profileCatalogs.has(pathname)) {
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => loadProfileCatalog(catalog, db, readDatabasePathIdentitySync(pathname)),
      { ...options, path: pathname },
    );
    profileCatalogs.set(pathname, catalog);
  }
  observeProfileCatalogs(true);
  const lease = Symbol("profile catalog lease");
  catalog.leases.add(lease);
  return () => releaseProfileCatalog(catalog, lease);
}

/** Prepare once off-thread; execution reads only committed facts retained by this owner. */
export async function prepareUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<{
  readonly emailBindingIds: readonly string[];
  assertCurrent(this: void, requiredEmailBindingIds?: readonly string[]): void;
  release(this: void): void;
}> {
  const context = captureOpenClawStateWorkerContext(options);
  const pathname = context.admission.databasePath;
  let refreshObserver = false;
  let catalog =
    profileCatalogs.get(pathname) ??
    [...profileCatalogs.values()].find(
      (candidate) => candidate.valid && candidate.identity.key === context.admission.identity.key,
    );
  if (catalog) {
    profileCatalogs.set(pathname, catalog);
  }
  while (
    !catalog?.valid ||
    catalog.identity.key !== context.admission.identity.key ||
    !profileBindings.has(catalog.rows)
  ) {
    const profileRevision = readUserProfileVersion();
    const bindingRevision = readUserProfileEmailBindingRevision();
    const reply = await executeExistingOpenClawStateRead(
      { ...options, path: pathname },
      { type: "userProfiles.catalog" },
      { current: true },
    );
    context.admission.assertCurrent();
    if (reply && (!reply.ok || reply.type !== "userProfiles.catalog")) {
      throw new Error(reply.ok ? "Unexpected profile catalog reply" : reply.message);
    }
    if (
      profileRevision !== readUserProfileVersion() ||
      bindingRevision !== readUserProfileEmailBindingRevision()
    ) {
      catalog = profileCatalogs.get(pathname);
      continue;
    }
    catalog =
      profileCatalogs.get(pathname) ??
      [...profileCatalogs.values()].find(
        (candidate) => candidate.valid && candidate.identity.key === context.admission.identity.key,
      );
    if (
      catalog?.valid &&
      catalog.identity.key === context.admission.identity.key &&
      profileBindings.has(catalog.rows)
    ) {
      profileCatalogs.set(pathname, catalog);
      break;
    }
    if (!catalog?.valid || catalog.identity.key !== context.admission.identity.key) {
      if (catalog) {
        catalog.valid = false;
      }
      catalog = {
        rows: new Map(reply?.profiles ?? []),
        identity: context.admission.identity,
        valid: true,
        leases: new Set(),
        asyncOnly: true,
      };
      refreshObserver = true;
      profileCatalogs.set(pathname, catalog);
      for (const publication of profilePublications) {
        retainProfilePublicationCatalog(publication, catalog, true);
      }
    }
    const bindings: ProfileBindings = { byEmail: new Map(), byId: new Map() };
    for (const binding of reply?.emailBindings ?? []) {
      applyEmailBinding(bindings, binding.email, binding);
    }
    profileBindings.set(catalog.rows, bindings);
    // Registration now sees prepared rows and never needs a cold host read.
    const cached = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(pathname);
    if (cached) {
      profileCatalogHandles.set(cached.db, catalog.rows);
    }
  }
  observeProfileCatalogs(refreshObserver);
  const retained = catalog;
  const identity = retained.identity.key;
  const rows = retained.rows;
  const bindings = profileBindings.get(rows)!;
  const initial = [...bindings.byEmail.values()].filter(
    (binding) => binding.profileId === profileId,
  );
  const ids = Object.freeze(
    initial.flatMap((binding) => (binding.bindingId ? [binding.bindingId] : [])).toSorted(),
  );
  const lease = Symbol("prepared profile identity");
  retained.leases.add(lease);
  let active = true;
  const assertCurrent = (requiredEmailBindingIds: readonly string[] = []) => {
    context.admission.assertCurrent();
    if (
      !active ||
      !retained.valid ||
      context.admission.identity.key !== identity ||
      retained.identity.key !== identity ||
      retained.rows !== rows ||
      resolveCatalogProfile(rows, profileId)?.id !== profileId ||
      requiredEmailBindingIds.some((id) => bindings.byId.get(id) !== profileId)
    ) {
      throw new UserProfileNotFoundError(profileId);
    }
  };
  return {
    get emailBindingIds() {
      assertCurrent();
      if (initial.some((binding) => binding.bindingId === null)) {
        throw new UserProfileNotFoundError(profileId);
      }
      return ids;
    },
    assertCurrent,
    release(this: void) {
      if (active) {
        active = false;
        releaseProfileCatalog(retained, lease);
      }
    },
  };
}

/** Stage exact changed keys before commit so observers always see the whole committed catalog. */
export function stageUserProfileCatalogChange(db: DatabaseSync, profileIds: string[]): void {
  const catalog = profileCatalogHandles.get(db);
  if (catalog) {
    const rows = selectProfileDisplayEntries(db, profileIds);
    stageSqliteTransactionState(db, {
      stage: () => {},
      rollback: () => {},
      commit: () => rows.forEach(([id, row]) => catalog.set(id, row)),
    });
  }
}

export function publishUserProfilesChange(db: DatabaseSync, ...profileIds: string[]): void {
  stageUserProfileCatalogChange(db, profileIds);
  deferSqlitePostCommitPublication(db, emitUserProfilesChanged);
}

/** Reads merge-aware display data without loading avatar bytes. */
export function getUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const profile = readProfileCatalog(
    options,
    (resident) => resolveCatalogProfile(resident, profileId),
    (db) =>
      selectResolvedUserProfile(
        db,
        profileId,
        userProfilesDb(db).selectFrom("user_profiles").select(userProfileDisplaySelection),
      ),
  );
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return projectUserProfileDisplay(profile);
}

/** Read a bounded display cohort and its one-hop merge targets without initializing storage. */
export function getUserProfileDisplays(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Map<string, ReturnType<typeof getUserProfileDisplay>> {
  const ids = [...new Set(profileIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const project = (resolve: (id: string) => Omit<ProfileDisplayRow, "role"> | undefined) =>
    new Map(
      ids.flatMap((id) => {
        const profile = resolve(id);
        return profile ? [[id, projectUserProfileDisplay(profile)] as const] : [];
      }),
    );
  return (
    readProfileCatalog(
      options,
      (resident) => project((id) => resolveCatalogProfile(resident, id)),
      (db) => {
        const profiles = userProfilesDb(db).selectFrom("user_profiles");
        const rows = executeSqliteQuerySync(
          db,
          profiles
            .select(userProfileDisplaySelection)
            .where((eb) =>
              eb.or([
                eb("id", "in", ids),
                eb(
                  "id",
                  "in",
                  profiles
                    .select("merged_into")
                    .where("id", "in", ids)
                    .where("merged_into", "!=", ""),
                ),
              ]),
            ),
        ).rows;
        if (
          rows.some(
            (row) =>
              typeof row.id !== "string" ||
              (row.merged_into !== null && typeof row.merged_into !== "string"),
          )
        ) {
          // Native BLOB keys compare by value in SQLite, not by Map object identity.
          return project((id) =>
            selectResolvedUserProfile(db, id, profiles.select(userProfileDisplaySelection)),
          );
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        return project((id) => {
          // Match native text binding before indexing the returned SQLite rows.
          const raw = byId.get(toUSVString(id));
          return raw?.merged_into ? (byId.get(raw.merged_into) ?? raw) : raw;
        });
      },
    ) ?? new Map()
  );
}

/** Activity references are display navigation, never authentication identifiers. */
export function resolveUserProfileReference(
  reference: string,
  options: OpenClawStateDatabaseOptions & { allowedProfileIds?: ReadonlySet<string> } = {},
): Result<string | undefined, "ambiguous"> {
  const { allowedProfileIds } = options;
  if (allowedProfileIds?.size === 0) {
    return ok(undefined);
  }
  const finish = (exact: string | undefined, readMatches: (prefix: string) => string[]) => {
    if (exact !== undefined || !/^[0-9a-f]{8,32}$/.test(reference)) {
      return ok<string | undefined, "ambiguous">(exact);
    }
    const prefix = [0, 8, 12, 16, 20]
      .map((start, index, offsets) => reference.slice(start, offsets[index + 1]))
      .filter(Boolean)
      .join("-");
    const matches = new Set(readMatches(prefix));
    return matches.size > 1
      ? err<string | undefined, "ambiguous">("ambiguous")
      : ok<string | undefined, "ambiguous">(matches.values().next().value);
  };
  return (
    readProfileCatalog(
      options,
      (resident) => {
        const allowed = (row: ProfileDisplayRow) =>
          !allowedProfileIds || allowedProfileIds.has(row.merged_into ?? row.id);
        const raw = resident.get(reference);
        return finish(
          raw && allowed(raw) ? resolveCatalogProfile(resident, reference)?.id : undefined,
          (prefix) =>
            [...resident.values()]
              .filter((row) => allowed(row) && row.id.toLowerCase().startsWith(prefix))
              .map((row) => row.merged_into ?? row.id),
        );
      },
      (db) => {
        let profiles = userProfilesDb(db).selectFrom("user_profiles");
        if (allowedProfileIds) {
          profiles = profiles.where((eb) =>
            eb(eb.fn.coalesce("merged_into", "id"), "in", [...allowedProfileIds]),
          );
        }
        return finish(
          selectResolvedUserProfile(db, reference, profiles.select(["id", "merged_into"]))?.id,
          (prefix) =>
            executeSqliteQuerySync(
              db,
              profiles
                .select((eb) => eb.fn.coalesce("merged_into", "id").as("id"))
                .where("id", "like", `${prefix}%`)
                .distinct()
                .limit(2),
            ).rows.map((row) => row.id),
        );
      },
    ) ?? ok(undefined)
  );
}
