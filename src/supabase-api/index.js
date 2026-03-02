const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const xlsx = require("xlsx");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase1 = createClient(
  "https://vvsagimqstdsgpxqhmyo.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2c2FnaW1xc3Rkc2dweHFobXlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NDAyMjcwNCwiZXhwIjoyMDU5NTk4NzA0fQ.2SOGnY4QcWNfXPjRKxHEVd3PAcooe3VdFG7zMkBVVkc"
);

const checkUserAndAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "accÃ¨s refusÃ©" });

  const { data: userInfo, error: userError } = await supabase.auth.getUser(
    token
  );
  if (userError || !userInfo?.user?.id) {
    return res.status(401).json({ error: "Token invalide" });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userInfo.user.id)
    .single();

  if (profileError) {
    return res
      .status(500)
      .json({ error: "Erreur lors de la vÃ©rification du rÃ´le" });
  }

  if (profile.role !== "admin") {
    return res.status(403).json({ error: "AccÃ¨s interdit" });
  }

  req.user = userInfo.user;
  next();
};

module.exports = { checkUserAndAdmin };

const checkAuth = (req, res, next) => {
  console.log("Auth header reÃ§u :", req.headers.authorization);

  if (!req.headers.authorization) {
    console.warn("âš ï¸ Aucun header Authorization reÃ§u !");
  }

  if (
    !req.headers.authorization ||
    req.headers.authorization !== `Bearer ${process.env.API_SECRET}`
  ) {
    return res.status(403).json({ error: "AccÃ¨s refusÃ©" });
  }

  next();
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const normalizeEmailValue = (value = "") =>
  value.toString().trim().toLowerCase();
const normalizeRoleValue = (value = "") =>
  value.toString().trim().toLowerCase();

const autoSyncPendingAndProfiles = async () => {
  const nowIso = new Date().toISOString();

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, email, username, role");
  if (profilesError) throw new Error(profilesError.message);

  const { data: pendingUsers, error: pendingError } = await supabase
    .from("pending_users")
    .select("id, email, username, role, is_active, auth_user_id, activated_at");
  if (pendingError) throw new Error(pendingError.message);

  const pendingByEmail = new Map(
    (pendingUsers || [])
      .filter((u) => u.email)
      .map((u) => [normalizeEmailValue(u.email), u])
  );

  const pendingUpserts = [];
  for (const profile of profiles || []) {
    if (!profile?.email) continue;
    const normalizedEmail = normalizeEmailValue(profile.email);
    const existingPending = pendingByEmail.get(normalizedEmail);

    pendingUpserts.push({
      ...(existingPending?.id ? { id: existingPending.id } : {}),
      email: normalizedEmail,
      username: profile.username || existingPending?.username || "",
      role: normalizeRoleValue(profile.role || existingPending?.role || "vigneron"),
      is_active: true,
      auth_user_id: profile.id,
      activated_at: existingPending?.activated_at || nowIso,
      updated_at: nowIso,
    });
  }

  if (pendingUpserts.length > 0) {
    const { error: pendingUpsertError } = await supabase
      .from("pending_users")
      .upsert(pendingUpserts, { onConflict: "email" });
    if (pendingUpsertError) throw new Error(pendingUpsertError.message);
  }

  const profileUpserts = [];
  for (const pending of pendingUsers || []) {
    if (!pending?.is_active || !pending?.auth_user_id || !pending?.email) continue;

    profileUpserts.push({
      id: pending.auth_user_id,
      email: normalizeEmailValue(pending.email),
      username: pending.username || "",
      role: normalizeRoleValue(pending.role || "vigneron"),
    });
  }

  if (profileUpserts.length > 0) {
    const { error: profileUpsertError } = await supabase
      .from("profiles")
      .upsert(profileUpserts, { onConflict: "id" });
    if (profileUpsertError) throw new Error(profileUpsertError.message);
  }

  return {
    pendingUpserts: pendingUpserts.length,
    profileUpserts: profileUpserts.length,
  };
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

app.post("/api/create-user", checkUserAndAdmin, async (req, res) => {
  const { email, password, role, username } = req.body;
  const normalizedEmail = (email || "").toString().trim().toLowerCase();

  if (!normalizedEmail || !password || !role || !username) {
    return res.status(400).json({ error: "Tous les champs sont requis." });
  }

  const { data: user, error } = await supabase.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  const authUserId = user?.user?.id;
  if (!authUserId) {
    return res.status(500).json({ error: "Utilisateur auth non créé." });
  }

  const { error: profileError } = await supabase.from("profiles").upsert(
    [{ id: authUserId, email: normalizedEmail, username, role }],
    { onConflict: "id" }
  );

  if (profileError) {
    await supabase.auth.admin.deleteUser(authUserId);
    return res.status(400).json({ error: profileError.message });
  }

  const { error: pendingError } = await supabase.from("pending_users").upsert(
    [
      {
        email: normalizedEmail,
        username,
        role,
        is_active: true,
        activated_at: new Date().toISOString(),
        auth_user_id: authUserId,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: "email" }
  );

  if (pendingError) {
    return res.status(400).json({ error: pendingError.message });
  }

  await autoSyncPendingAndProfiles();

  res.json({ success: true, id: authUserId });
});
app.post("/api/sync-vignerons", checkAuth, async (req, res) => {
  const { emailsToKeep } = req.body;

  if (!Array.isArray(emailsToKeep)) {
    return res
      .status(400)
      .json({ error: "emailsToKeep doit Ãªtre un tableau." });
  }

  try {
    const { data: existingVignerons, error } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("role", "vigneron");

    if (error) {
      console.error("âŒ Erreur rÃ©cupÃ©ration profils :", error.message);
      return res.status(500).json({ error: error.message });
    }

    const toDelete = existingVignerons.filter(
      (user) => !emailsToKeep.includes(user.email)
    );

    if (toDelete.length === 0) {
      return res.json({ success: true, deleted: [] });
    }

    for (const user of toDelete) {
      const { error: authError } = await supabase.auth.admin.deleteUser(
        user.id
      );
      if (authError) {
        console.error(
          `âŒ Erreur Auth delete (${user.email}) :`,
          authError.message
        );
        return res.status(500).json({ error: authError.message });
      }
      const { error: profileError } = await supabase
        .from("profiles")
        .delete()
        .eq("id", user.id);

      if (profileError) {
        console.error(
          `âŒ Erreur profil delete (${user.email}) :`,
          profileError.message
        );
        return res.status(500).json({ error: profileError.message });
      }
    }

    res.json({ success: true, deleted: toDelete.map((u) => u.email) });
  } catch (err) {
    console.error("âŒ Erreur interne :", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/import-users", async (req, res) => {
  const { users, emailsToKeep } = req.body;

  if (!Array.isArray(users) || !Array.isArray(emailsToKeep)) {
    return res.status(400).json({ error: "Format de donnÃ©es invalide." });
  }

  const created = [];
  const failed = [];
  const importedPending = [];

  const normalizeEmail = (value = "") => value.toString().trim().toLowerCase();
  const normalizeRole = (value = "") => value.toString().trim().toLowerCase();
  const nowIso = new Date().toISOString();

  const { data: existingPending, error: pendingFetchError } = await supabase
    .from("pending_users")
    .select("*");

  if (pendingFetchError) {
    return res.status(500).json({ error: pendingFetchError.message });
  }

  const pendingMap = new Map(
    (existingPending || []).map((u) => [normalizeEmail(u.email), u])
  );

  for (const user of users) {
    const { email, role, username, password } = user;
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = normalizeRole(role);
    const normalizedPassword = (password || "").toString().trim();
    const existingPendingUser = pendingMap.get(normalizedEmail);

    if (!normalizedEmail || !normalizedRole || !username) {
      failed.push({ email, error: "Champs manquants" });
      continue;
    }

    try {
      let authUserId = existingPendingUser?.auth_user_id || null;
      let isActive = !!existingPendingUser?.is_active;

      if (normalizedPassword) {
        if (authUserId) {
          const { error: updateAuthError } = await supabase.auth.admin.updateUserById(
            authUserId,
            {
              email: normalizedEmail,
              password: normalizedPassword,
            }
          );
          if (updateAuthError) {
            failed.push({ email: normalizedEmail, error: updateAuthError.message });
            continue;
          }
        } else {
          const { data: authUser, error: authCreateError } =
            await supabase.auth.admin.createUser({
              email: normalizedEmail,
              password: normalizedPassword,
              email_confirm: true,
            });
          if (authCreateError) {
            failed.push({ email: normalizedEmail, error: authCreateError.message });
            continue;
          }
          authUserId = authUser?.user?.id || null;
          if (!authUserId) {
            failed.push({ email: normalizedEmail, error: "ID auth introuvable." });
            continue;
          }
        }

        const { error: profileUpsertError } = await supabase.from("profiles").upsert(
          [
            {
              id: authUserId,
              email: normalizedEmail,
              username,
              role: normalizedRole,
            },
          ],
          { onConflict: "id" }
        );
        if (profileUpsertError) {
          failed.push({
            email: normalizedEmail,
            error: profileUpsertError.message,
          });
          continue;
        }
        isActive = true;
      }

      const pendingPayload = {
        email: normalizedEmail,
        username,
        role: normalizedRole,
        is_active: isActive,
        auth_user_id: authUserId,
        updated_at: nowIso,
      };
      if (isActive) {
        pendingPayload.activated_at = existingPendingUser?.activated_at || nowIso;
      }

      const { error: pendingUpsertError } = await supabase
        .from("pending_users")
        .upsert([pendingPayload], { onConflict: "email" });
      if (pendingUpsertError) {
        failed.push({ email: normalizedEmail, error: pendingUpsertError.message });
        continue;
      }

      pendingMap.set(normalizedEmail, {
        ...(existingPendingUser || {}),
        ...pendingPayload,
      });
      importedPending.push(normalizedEmail);
      created.push(normalizedEmail);
    } catch (err) {
      failed.push({ email: normalizedEmail, error: err.message });
    }
  }

  try {
    const { data: existingVignerons, error } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("role", "vigneron");

    if (error) {
      console.error("âŒ Erreur rÃ©cupÃ©ration vignerons :", error.message);
      return res.status(500).json({ error: error.message });
    }

    const normalizedEmailsToKeep = emailsToKeep.map(normalizeEmail);
    const toDelete = existingVignerons.filter(
      (user) => !normalizedEmailsToKeep.includes(normalizeEmail(user.email))
    );

    for (const user of toDelete) {
      const { error: authError } = await supabase.auth.admin.deleteUser(
        user.id
      );
      if (authError) {
        console.error(
          `âŒ Erreur Auth delete (${user.email}) :`,
          authError.message
        );
        return res.status(500).json({ error: authError.message });
      }
      const { error: profileError } = await supabase
        .from("profiles")
        .delete()
        .eq("id", user.id);

      if (profileError) {
        console.error(
          `âŒ Erreur profil delete (${user.email}) :`,
          profileError.message
        );
        return res.status(500).json({ error: profileError.message });
      }
    }

    const { data: existingAllPending, error: pendingAllError } = await supabase
      .from("pending_users")
      .select("email, role");

    if (pendingAllError) {
      return res.status(500).json({ error: pendingAllError.message });
    }

    const pendingVigneronsToDelete = (existingAllPending || []).filter(
      (user) =>
        user.role === "vigneron" &&
        !normalizedEmailsToKeep.includes(normalizeEmail(user.email))
    );

    if (pendingVigneronsToDelete.length > 0) {
      const pendingEmailsToDelete = pendingVigneronsToDelete.map((u) =>
        normalizeEmail(u.email)
      );
      const { error: pendingDeleteError } = await supabase
        .from("pending_users")
        .delete()
        .in("email", pendingEmailsToDelete);

      if (pendingDeleteError) {
        return res.status(500).json({ error: pendingDeleteError.message });
      }
    }

    await autoSyncPendingAndProfiles();

    res.json({
      success: true,
      created,
      pendingImported: importedPending,
      failed,
      deleted: toDelete.map((u) => u.email),
      deletedPending: pendingVigneronsToDelete.map((u) => u.email),
    });
  } catch (err) {
    console.error("âŒ Erreur finale :", err.message);
    res.status(500).json({ error: err.message });
  }
});

const getPendingUserByIdOrEmail = async (identifier) => {
  const byId = await supabase
    .from("pending_users")
    .select("*")
    .eq("id", identifier)
    .maybeSingle();

  if (byId.data) {
    return { data: byId.data, lookupField: "id", error: null };
  }

  const byEmail = await supabase
    .from("pending_users")
    .select("*")
    .eq("email", identifier)
    .maybeSingle();

  if (byEmail.data) {
    return { data: byEmail.data, lookupField: "email", error: null };
  }

  return {
    data: null,
    lookupField: "id",
    error: byId.error || byEmail.error,
  };
};

app.get("/api/users", checkUserAndAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("pending_users")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const formatted = (data || []).map((u) => ({
      id: u.id || u.email,
      username: u.username || "",
      email: u.email || "",
      role: u.role || "vigneron",
      is_active: !!u.is_active,
      auth_user_id: u.auth_user_id || null,
      activated_at: u.activated_at || null,
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/users/:id", checkUserAndAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const {
      data: pendingUser,
      lookupField,
      error: pendingFetchError,
    } = await getPendingUserByIdOrEmail(id);

    if (!pendingUser) {
      return res
        .status(404)
        .json({ error: pendingFetchError?.message || "Utilisateur introuvable." });
    }

    if (pendingUser.auth_user_id) {
      const { error: authError } = await supabase.auth.admin.deleteUser(
        pendingUser.auth_user_id
      );
      if (authError) throw new Error(authError.message);

      const { error: profileError } = await supabase
        .from("profiles")
        .delete()
        .eq("id", pendingUser.auth_user_id);
      if (profileError) throw new Error(profileError.message);
    }

    const { error: pendingDeleteError } = await supabase
      .from("pending_users")
      .delete()
      .eq(lookupField, pendingUser[lookupField]);
    if (pendingDeleteError) throw new Error(pendingDeleteError.message);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/users/:id", checkUserAndAdmin, async (req, res) => {
  const { id } = req.params;
  const { username, email, role } = req.body;
  const normalizedEmail = email ? email.toString().trim().toLowerCase() : undefined;

  try {
    const {
      data: pendingUser,
      lookupField,
      error: pendingFetchError,
    } = await getPendingUserByIdOrEmail(id);

    if (!pendingUser) {
      return res
        .status(404)
        .json({ error: pendingFetchError?.message || "Utilisateur introuvable." });
    }

    const pendingUpdates = {
      updated_at: new Date().toISOString(),
    };
    if (username !== undefined) pendingUpdates.username = username;
    if (normalizedEmail !== undefined) pendingUpdates.email = normalizedEmail;
    if (role !== undefined) pendingUpdates.role = role;

    const { error: pendingUpdateError } = await supabase
      .from("pending_users")
      .update(pendingUpdates)
      .eq(lookupField, pendingUser[lookupField]);
    if (pendingUpdateError) {
      return res.status(500).json({ success: false, error: pendingUpdateError.message });
    }

    if (pendingUser.auth_user_id) {
      if (normalizedEmail !== undefined) {
        const { error: authUpdateError } = await supabase.auth.admin.updateUserById(
          pendingUser.auth_user_id,
          { email: normalizedEmail }
        );
        if (authUpdateError) {
          return res.status(500).json({ success: false, error: authUpdateError.message });
        }
      }

      const profileUpdates = {};
      if (username !== undefined) profileUpdates.username = username;
      if (normalizedEmail !== undefined) profileUpdates.email = normalizedEmail;
      if (role !== undefined) profileUpdates.role = role;

      if (Object.keys(profileUpdates).length > 0) {
        const { error: profileUpdateError } = await supabase
          .from("profiles")
          .update(profileUpdates)
          .eq("id", pendingUser.auth_user_id);
        if (profileUpdateError) {
          return res
            .status(500)
            .json({ success: false, error: profileUpdateError.message });
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/users/:id", checkUserAndAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await getPendingUserByIdOrEmail(id);
    if (!data) {
      return res.status(404).json({ error: error?.message || "Utilisateur introuvable." });
    }

    res.json({
      id: data.id || data.email,
      username: data.username || "",
      email: data.email || "",
      role: data.role || "vigneron",
      is_active: !!data.is_active,
      auth_user_id: data.auth_user_id || null,
      activated_at: data.activated_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users/sync", checkUserAndAdmin, async (_req, res) => {
  try {
    const stats = await autoSyncPendingAndProfiles();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/upload-document", upload.single("file"), async (req, res) => {
  const { titre, description, date_publication, categorie } = req.body;
  const file = req.file;

  if (!titre || !date_publication || !categorie || !file) {
    return res.status(400).json({ error: "Champs requis manquants." });
  }
  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(file.path);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Erreur lecture fichier temporaire." });
  }
  const fileName = `${Date.now()}-${file.originalname}`;
  try {
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(fileName, fileBuffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error("Erreur Supabase upload :", uploadError.message);
      return res.status(500).json({ error: uploadError.message });
    }
    const { publicUrl } = supabase.storage
      .from("documents")
      .getPublicUrl(fileName).data;
    try {
      fs.unlinkSync(file.path);
    } catch (err) {}
    const { error: dbError } = await supabase.from("documents").insert([
      {
        titre,
        description,
        date_publication,
        file_url: publicUrl,
        categorie,
      },
    ]);

    if (dbError) {
      console.error("âŒ Erreur insert document :", dbError.message);
      return res.status(500).json({ error: dbError.message });
    }

    res.json({ success: true, file_url: publicUrl });
  } catch (err) {
    console.error("âŒ Erreur serveur API /api/upload-document :", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/documents", checkAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("âŒ Erreur fetch documents :", error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("âŒ Erreur serveur GET /api/documents :", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "uploads", filename);
  if (fs.existsSync(filePath)) {
    return res.download(filePath);
  } else {
    return res.status(404).send("Fichier introuvable");
  }
});

app.post("/api/import-domaines", upload.single("file"), async (req, res) => {
  try {
    console.log("Fichier reÃ§u :", req.file);

    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const domaines = xlsx.utils.sheet_to_json(sheet);
    console.log("DonnÃ©es extraites du fichier :", domaines);
    const formatted = domaines
      .map((row) => {
        const nom = row.nom?.trim().toLowerCase();
        return {
          nom: nom || null,
          description: row.description || null,
          adresse: row.adresse || null,
          certification: row.certification || null,
          ville: row.ville || null,
          lat: row.lat ? parseFloat(row.lat) : null,
          lon: row.lon ? parseFloat(row.lon) : null,
          telephone: row.telephone || null,
          email: row.email || null,
          appellation: row.appellation || null,
          commune: row.commune || null,
          type_vigne: row.type_vigne || null,
          variete: row.variete || null,
          nature_vin: row.nature_vin || null,
          competence: row.competence || null,
          autres_competences: row.autres_competences || null, // Ajout rÃ©cupÃ©ration colonne autres_competences
        };
      })
      .filter((row) =>
        Object.values(row).some((value) => value !== null && value !== "")
      )
      .filter((row) => row.nom);
    const uniquesParNom = Array.from(
      new Map(formatted.map((d) => [d.nom, d])).values()
    );

    console.log("DonnÃ©es aprÃ¨s nettoyage :", uniquesParNom);
    const { error: upsertError } = await supabase
      .from("domaines_viticoles")
      .upsert(uniquesParNom, { onConflict: ["nom"] });

    if (upsertError) {
      console.error("Erreur lors de l'upsert :", upsertError);
      throw new Error(upsertError.message);
    }
    const { data: allDomaines, error: fetchError } = await supabase
      .from("domaines_viticoles")
      .select("nom");

    if (fetchError) {
      console.error("Erreur lors de la rÃ©cupÃ©ration :", fetchError);
      throw new Error(fetchError.message);
    }
    const nomsDansFichier = uniquesParNom.map((d) => d.nom);
    const nomsDansBase = allDomaines.map((d) => d.nom);
    const nomsASupprimer = nomsDansBase.filter(
      (nom) => !nomsDansFichier.includes(nom)
    );

    if (nomsASupprimer.length > 0) {
      const { error: deleteError } = await supabase
        .from("domaines_viticoles")
        .delete()
        .in("nom", nomsASupprimer);

      if (deleteError) {
        console.error("Erreur lors de la suppression :", deleteError);
        throw new Error(deleteError.message);
      }
    }

    res.json({
      success: true,
      imported: uniquesParNom.length,
      deleted: nomsASupprimer.length,
    });
  } catch (err) {
    console.error("Erreur serveur :", err.message);
    res.status(500).json({ error: "Erreur lors de l'import : " + err.message });
  } finally {
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.warn("âš ï¸ Impossible de supprimer le fichier :", err.message);
    }
  }
});

// Lister tous les Ã©vÃ©nements

app.get("/api/evenements", async (req, res) => {
  const { data, error } = await supabase
    .from("evenements")
    .select("*")
    .order("date_evenement", { ascending: true });

  if (error) {
    console.error("âŒ Erreur rÃ©cupÃ©ration Ã©vÃ©nements :", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

//  RÃ©cupÃ©rer un Ã©vÃ©nement par ID

app.get("/api/evenements/:id", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("evenements")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    console.error("âŒ Erreur rÃ©cupÃ©ration Ã©vÃ©nement :", error?.message);
    return res.status(404).json({ error: "Ã‰vÃ©nement non trouvÃ©" });
  }

  res.json(data);
});

//  Ajouter un Ã©vÃ©nement (avec lien)

app.post("/api/evenements", async (req, res) => {
  const { titre, lieu, date_evenement, description, type, lien } = req.body;

  const { data, error } = await supabase
    .from("evenements")
    .insert([{ titre, lieu, date_evenement, description, type, lien }])
    .select()
    .single();

  if (error) {
    console.error("âŒ Erreur ajout Ã©vÃ©nement :", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true, event: data });
});

//  Modifier un Ã©vÃ©nement existant (avec lien)

app.put("/api/evenements/:id", async (req, res) => {
  const { id } = req.params;
  const { titre, lieu, date_evenement, description, type, lien } = req.body;

  const { error } = await supabase
    .from("evenements")
    .update({ titre, lieu, date_evenement, description, type, lien })
    .eq("id", id);

  if (error) {
    console.error("âŒ Erreur mise Ã  jour Ã©vÃ©nement :", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

//  Supprimer un Ã©vÃ©nement

app.delete("/api/evenements/:id", async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from("evenements").delete().eq("id", id);

  if (error) {
    console.error("âŒ Erreur suppression Ã©vÃ©nement :", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

//  gestion de la liste des domaines viticoles

app.get("/api/domaines", checkAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("domaines_viticoles")
      .select("*")
      .order("nom", { ascending: true });

    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    console.error("âŒ Erreur /api/domaines :", err.message);
    res.status(500).json({ error: "Erreur lors de la rÃ©cupÃ©ration" });
  }
});

// modifier un document le suppr etc

app.get("/api/documents/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Document non trouvÃ©" });
  }

  res.json(data);
});

app.put("/api/documents/:id", upload.single("file"), async (req, res) => {
  const { id } = req.params;
  let { titre, description, date_publication, categorie, file_url } = req.body;
  let newFileUrl = file_url;

  if (req.file) {
    try {
      const fileBuffer = fs.readFileSync(req.file.path);
      const fileName = `${Date.now()}-${req.file.originalname}`;
      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(fileName, fileBuffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error("Erreur Supabase upload :", uploadError.message);
        return res.status(500).json({ error: uploadError.message });
      }

      const { publicUrl } = supabase.storage
        .from("documents")
        .getPublicUrl(fileName).data;

      newFileUrl = publicUrl;

      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {}
    } catch (err) {
      return res
        .status(500)
        .json({ error: "Erreur upload fichier : " + err.message });
    }
  }
  const updateObj = {
    titre,
    description,
    date_publication,
    categorie,
  };
  if (newFileUrl) updateObj.file_url = newFileUrl;

  Object.keys(updateObj).forEach(
    (key) =>
      (updateObj[key] === undefined || updateObj[key] === "") &&
      delete updateObj[key]
  );

  const { error } = await supabase
    .from("documents")
    .update(updateObj)
    .eq("id", id);

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

// DELETE un document
app.delete("/api/documents/:id", async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase.from("documents").delete().eq("id", id);

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "Aucun fichier envoyÃ©." });
  }

  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(file.path);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Erreur lecture fichier temporaire." });
  }

  const fileName = `${Date.now()}-${file.originalname}`;

  try {
    const { error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(fileName, fileBuffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error("Erreur Supabase upload :", uploadError.message);
      return res.status(500).json({ error: uploadError.message });
    }

    const { publicUrl } = supabase.storage
      .from("uploads")
      .getPublicUrl(fileName).data;
    try {
      fs.unlinkSync(file.path);
    } catch (err) {}

    res.json({ url: publicUrl });
  } catch (err) {
    console.error("Erreur serveur :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// articles

app.post("/api/articles", upload.single("image"), async (req, res) => {
  const { titre, description, contenu, lien } = req.body;
  const file = req.file;

  if (!titre || !description || !contenu || !file) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  const fileName = `${Date.now()}-${file.originalname}`;

  try {
    const { error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error("âŒ Erreur upload image :", uploadError.message);
      return res.status(500).json({ error: "Erreur upload image Supabase." });
    }

    const { publicUrl } = supabase.storage
      .from("uploads")
      .getPublicUrl(fileName).data;

    const { error: dbError } = await supabase.from("fil_actualite").insert([
      {
        titre,
        description,
        contenu,
        lien: lien || null,
        image_url: publicUrl,
      },
    ]);

    if (dbError) {
      console.error("âŒ Erreur insertion actualitÃ© :", dbError.message);
      return res.status(500).json({ error: dbError.message });
    }

    res.json({ success: true, image_url: publicUrl });
  } catch (err) {
    console.error("âŒ Erreur serveur :", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("categorie")
      .neq("categorie", null);

    if (error) throw error;

    const uniqueCats = Array.from(
      new Set((data || []).map((d) => d.categorie).filter(Boolean))
    ).map((cat) => ({
      id: cat,
      nom: cat,
    }));

    res.json(uniqueCats);
  } catch (err) {
    console.error("Erreur rÃ©cupÃ©ration catÃ©gories :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// partenaires
app.get("/api/partenaires", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("partenaires")
      .select("*")
      .order("id", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/activate-user", async (req, res) => {
  const { email, password, activation_token } = req.body;

  const normalizedEmail = (email || "").toString().trim().toLowerCase();
  const inputToken = (activation_token || "").toString().trim();
  const normalizeToken = (value = "") => value.toString().trim();

  if (!normalizedEmail || !password || !inputToken) {
    return res
      .status(400)
      .json({ error: "Email, mot de passe et token d'activation requis." });
  }

  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: "Mot de passe trop court (minimum 6 caractères)." });
  }

  try {
    const { data: pendingUser, error: pendingError } = await supabase
      .from("pending_users")
      .select("id, email, username, role, is_active, auth_user_id")
      .eq("email", normalizedEmail)
      .single();

    if (pendingError || !pendingUser) {
      return res.status(404).json({
        error:
          "Email non autorisé. Demandez à l'administrateur de vous importer.",
      });
    }

    if (pendingUser.is_active && pendingUser.auth_user_id) {
      return res
        .status(400)
        .json({ error: "Ce compte a déjà été activé. Connectez-vous." });
    }

    const { data: tokens, error: settingsError } = await supabase
      .from("settings")
      .select("key, value")
      .in("key", ["first_login_public_token", "first_login_admin_token"]);

    if (settingsError) {
      return res.status(500).json({ error: settingsError.message });
    }

    const publicToken =
      tokens?.find((item) => item.key === "first_login_public_token")?.value ||
      "";
    const adminToken =
      tokens?.find((item) => item.key === "first_login_admin_token")?.value || "";

    const expectedToken =
      (pendingUser.role || "").toLowerCase() === "admin" ? adminToken : publicToken;

    if (!expectedToken) {
      return res.status(500).json({
        error: "Token de première connexion non configuré côté administration.",
      });
    }

    if (normalizeToken(inputToken) !== normalizeToken(expectedToken)) {
      return res.status(403).json({ error: "Token d'activation invalide." });
    }

    let userId = pendingUser.auth_user_id || null;
    let createdNow = false;

    if (userId) {
      const { error: authUpdateError } = await supabase.auth.admin.updateUserById(
        userId,
        {
          email: normalizedEmail,
          password,
        }
      );
      if (authUpdateError) {
        return res.status(400).json({ error: authUpdateError.message });
      }
    } else {
      const { data: createdAuth, error: authError } =
        await supabase.auth.admin.createUser({
          email: normalizedEmail,
          password,
          email_confirm: true,
        });
      if (authError) {
        return res.status(400).json({ error: authError.message });
      }

      userId = createdAuth?.user?.id || null;
      if (!userId) {
        return res.status(500).json({ error: "Création utilisateur incomplète." });
      }
      createdNow = true;
    }

    const { error: profileError } = await supabase.from("profiles").upsert(
      [
        {
          id: userId,
          email: normalizedEmail,
          username: pendingUser.username,
          role: pendingUser.role || "vigneron",
        },
      ],
      { onConflict: "id" }
    );

    if (profileError) {
      if (createdNow) {
        await supabase.auth.admin.deleteUser(userId);
      }
      return res.status(400).json({ error: profileError.message });
    }

    const { error: pendingUpdateError } = await supabase
      .from("pending_users")
      .update({
        is_active: true,
        auth_user_id: userId,
        activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("email", normalizedEmail);

    if (pendingUpdateError) {
      return res.status(500).json({ error: pendingUpdateError.message });
    }

    await autoSyncPendingAndProfiles();

    res.json({
      success: true,
      message: "Compte activé, vous pouvez vous connecter.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/partenaires", async (req, res) => {
  try {
    const { nom, description, image_url, lien_site } = req.body;
    if (!nom || !description) {
      return res.status(400).json({ error: "Nom et description requis." });
    }

    const { data, error } = await supabase
      .from("partenaires")
      .insert([
        {
          nom,
          description,
          image_url: image_url || null,
          lien_site: lien_site || null,
        },
      ])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, partenaire: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/partenaires/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, description, image_url, lien_site } = req.body;

    const updateObj = { nom, description, image_url, lien_site };
    Object.keys(updateObj).forEach(
      (key) => updateObj[key] === undefined && delete updateObj[key]
    );

    const { data, error } = await supabase
      .from("partenaires")
      .update(updateObj)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, partenaire: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/partenaires/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("partenaires").delete().eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Lanceement du serveur
app.listen(3001, async () => {
  console.log("ðŸš€ API dÃ©marrÃ©e sur https://render-pfyp.onrender.com/");
  try {
    const stats = await autoSyncPendingAndProfiles();
    console.log("âœ… Sync auto utilisateurs au démarrage :", stats);
  } catch (err) {
    console.error("âŒ Échec sync auto au démarrage :", err.message);
  }
});


