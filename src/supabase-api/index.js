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

  if (!token) return res.status(401).json({ error: "accès refusé" });

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
      .json({ error: "Erreur lors de la vérification du rôle" });
  }

  if (profile.role !== "admin") {
    return res.status(403).json({ error: "Accès interdit" });
  }

  req.user = userInfo.user;
  next();
};

module.exports = { checkUserAndAdmin };

const checkAuth = (req, res, next) => {
  console.log("Auth header reçu :", req.headers.authorization);

  if (!req.headers.authorization) {
    console.warn("⚠️ Aucun header Authorization reçu !");
  }

  if (
    !req.headers.authorization ||
    req.headers.authorization !== `Bearer ${process.env.API_SECRET}`
  ) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  next();
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// Fonction pour normaliser les noms de fichiers (supprimer accents et caractères spéciaux)
function normalizeFileName(filename) {
  return filename
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // retire accents
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // remplace caractères spéciaux par _
}

app.post("/api/create-user", async (req, res) => {
  const { email, password, role, username } = req.body;

  console.log("📥 Données reçues :", { email, password, role, username });

  if (!email || !password || !role || !username) {
    return res.status(400).json({ error: "Tous les champs sont requis." });
  }

  const { data: user, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    console.error("❌ Erreur Auth :", error.message);
    return res.status(400).json({ error: error.message });
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .insert([{ id: user.user.id, email, username, role }]);

  if (profileError) {
    console.error("❌ Erreur profil :", profileError.message);
    return res.status(400).json({ error: profileError.message });
  }

  console.log("✅ Utilisateur créé :", user.user.id);
  res.json({ success: true });
});
app.post("/api/sync-vignerons", checkAuth, async (req, res) => {
  const { emailsToKeep } = req.body;

  if (!Array.isArray(emailsToKeep)) {
    return res
      .status(400)
      .json({ error: "emailsToKeep doit être un tableau." });
  }

  try {
    const { data: existingVignerons, error } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("role", "vigneron");

    if (error) {
      console.error("❌ Erreur récupération profils :", error.message);
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
          `❌ Erreur Auth delete (${user.email}) :`,
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
          `❌ Erreur profil delete (${user.email}) :`,
          profileError.message
        );
        return res.status(500).json({ error: profileError.message });
      }
    }

    res.json({ success: true, deleted: toDelete.map((u) => u.email) });
  } catch (err) {
    console.error("❌ Erreur interne :", err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/import-users", async (req, res) => {
  const { users, emailsToKeep } = req.body;

  if (!Array.isArray(users) || !Array.isArray(emailsToKeep)) {
    return res.status(400).json({ error: "Format de données invalide." });
  }

  const created = [];
  const failed = [];
  for (const user of users) {
    const { email, password, role, username } = user;

    if (!email || !password || !role || !username) {
      failed.push({ email, error: "Champs manquants" });
      continue;
    }

    try {
      const { data: authUser, error: authError } =
        await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });

      if (authError) {
        failed.push({ email, error: authError.message });
        continue;
      }

      const { error: profileError } = await supabase
        .from("profiles")
        .insert([{ id: authUser.user.id, email, username, role }]);

      if (profileError) {
        failed.push({ email, error: profileError.message });
      } else {
        created.push(email);
      }
    } catch (err) {
      failed.push({ email, error: err.message });
    }
  }
  try {
    const { data: existingVignerons, error } = await supabase
      .from("profiles")
      .select("id, email")
      .eq("role", "vigneron");

    if (error) {
      console.error("❌ Erreur récupération vignerons :", error.message);
      return res.status(500).json({ error: error.message });
    }

    const toDelete = existingVignerons.filter(
      (user) => !emailsToKeep.includes(user.email)
    );

    for (const user of toDelete) {
      const { error: authError } = await supabase.auth.admin.deleteUser(
        user.id
      );
      if (authError) {
        console.error(
          `❌ Erreur Auth delete (${user.email}) :`,
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
          `❌ Erreur profil delete (${user.email}) :`,
          profileError.message
        );
        return res.status(500).json({ error: profileError.message });
      }
    }

    res.json({
      success: true,
      created,
      failed,
      deleted: toDelete.map((u) => u.email),
    });
  } catch (err) {
    console.error("❌ Erreur finale :", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users", checkUserAndAdmin, async (req, res) => {
  const accessToken = req.headers.authorization?.split(" ")[1];

  if (!accessToken) {
    return res.status(401).json({ error: "Token manquant" });
  }

  try {
    const { data: userInfo, error: userError } = await supabase.auth.getUser(
      accessToken
    );

    if (userError || !userInfo?.user?.id) {
      return res.status(401).json({ error: "Utilisateur non authentifié" });
    }

    const userId = userInfo.user.id;

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (profileError || profile?.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Accès réservé aux administrateurs" });
    }
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, email, role");

    if (error) {
      console.error("❌ Erreur récupération utilisateurs :", error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("❌ Erreur interne /api/users :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// suppr un user

app.delete("/api/users/:id", checkUserAndAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { error: authError } = await supabase.auth.admin.deleteUser(id);
    if (authError) throw new Error(authError.message);
    const { error: profileError } = await supabase
      .from("profiles")
      .delete()
      .eq("id", id);

    if (profileError) throw new Error(profileError.message);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Erreur suppression utilisateur :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Modifier un utilisateur

app.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { username, email, password } = req.body;

  const updates = { username, email };

  if (password && password.trim() !== "") {
    updates.password = password;
  }

  const { error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", id);

  if (error) {
    console.error("❌ PUT utilisateur :", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

app.get("/api/users/:id", checkUserAndAdmin, async (req, res) => {
  const { id } = req.params;
  console.log("🔍 ID reçu:", id);

  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, email, role")
    .eq("id", id)
    .single();

  if (error) {
    console.error("❌ Erreur Supabase :", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
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
  const fileName = `${Date.now()}-${normalizeFileName(file.originalname)}`;
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
      console.error("❌ Erreur insert document :", dbError.message);
      return res.status(500).json({ error: dbError.message });
    }

    res.json({ success: true, file_url: publicUrl });
  } catch (err) {
    console.error("❌ Erreur serveur API /api/upload-document :", err.message);
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
      console.error("❌ Erreur fetch documents :", error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("❌ Erreur serveur GET /api/documents :", err.message);
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
    console.log("Fichier reçu :", req.file);

    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const domaines = xlsx.utils.sheet_to_json(sheet);
    console.log("Données extraites du fichier :", domaines);
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
          autres_competences: row.autres_competences || null, // Ajout récupération colonne autres_competences
          implication: row.implication || null, // Ajout récupération colonne implication
        };
      })
      .filter((row) =>
        Object.values(row).some((value) => value !== null && value !== "")
      )
      .filter((row) => row.nom);
    const uniquesParNom = Array.from(
      new Map(formatted.map((d) => [d.nom, d])).values()
    );

    console.log("Données après nettoyage :", uniquesParNom);
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
      console.error("Erreur lors de la récupération :", fetchError);
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
      console.warn("⚠️ Impossible de supprimer le fichier :", err.message);
    }
  }
});

// Lister tous les événements

app.get("/api/evenements", async (req, res) => {
  const { data, error } = await supabase
    .from("evenements")
    .select("*")
    .order("date_evenement", { ascending: true });

  if (error) {
    console.error("❌ Erreur récupération événements :", error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

//  Récupérer un événement par ID

app.get("/api/evenements/:id", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("evenements")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    console.error("❌ Erreur récupération événement :", error?.message);
    return res.status(404).json({ error: "Événement non trouvé" });
  }

  res.json(data);
});

//  Ajouter un événement (avec lien)

app.post("/api/evenements", async (req, res) => {
  try {
    const {
      titre,
      lieu,
      date_evenement,
      description,
      type,
      lien,
      banniere_url, // L'URL de l'image envoyée depuis le front
    } = req.body;

    // Vérification basique
    if (!titre || !lieu || !date_evenement || !type) {
      return res.status(400).json({
        success: false,
        error: "Champs obligatoires manquants.",
      });
    }

    // Création de l'objet à insérer
    const insertObj = {
      titre,
      lieu,
      date_evenement,
      description,
      type,
      lien,
      banniere_url: banniere_url || null,
    };

    // Insertion dans la table "evenements"
    const { data, error } = await supabase
      .from("evenements")
      .insert([insertObj])
      .select()
      .single();

    if (error) {
      console.error("❌ Erreur ajout événement :", error.message);
      return res.status(500).json({
        success: false,
        error: "Erreur lors de l'ajout de l'événement.",
      });
    }

    res.json({ success: true, event: data });
  } catch (err) {
    console.error("❌ Erreur serveur :", err.message);
    res.status(500).json({ success: false, error: "Erreur serveur." });
  }
});

//  Modifier un événement existant (avec lien)

app.put("/api/evenements/:id", async (req, res) => {
  const { id } = req.params;
  const {
    titre,
    lieu,
    date_evenement,
    description,
    type,
    lien,
    banniere_url, // Ajout ici
  } = req.body;

  const updateFields = {
    titre,
    lieu,
    date_evenement,
    description,
    type,
    lien,
    banniere_url, // Et ici
  };

  const { error } = await supabase
    .from("evenements")
    .update(updateFields)
    .eq("id", id);

  if (error) {
    console.error("❌ Erreur mise à jour événement :", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

//  Supprimer un événement

app.delete("/api/evenements/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("evenements").delete().eq("id", id);
  if (error) {
    console.error("❌ Erreur suppression événement :", error.message);
    res.status(500).json({ success: false, error: error.message });
    return;
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
    console.error("❌ Erreur /api/domaines :", err.message);
    res.status(500).json({ error: "Erreur lors de la récupération" });
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
    res.status(404).json({ error: "Document non trouvé" });
    return;
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
      const fileName = `${Date.now()}-${normalizeFileName(
        req.file.originalname
      )}`;
      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(fileName, fileBuffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });
      if (uploadError) {
        console.error("Erreur Supabase upload :", uploadError.message);
        res.status(500).json({ error: uploadError.message });
        return;
      }
      const { publicUrl } = supabase.storage
        .from("documents")
        .getPublicUrl(fileName).data;
      newFileUrl = publicUrl;
      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {}
    } catch (err) {
      res.status(500).json({ error: "Erreur upload fichier : " + err.message });
      return;
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
    res.status(500).json({ success: false, error: error.message });
    return;
  }
  res.json({ success: true });
});

// DELETE un document
app.delete("/api/documents/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) {
    res.status(500).json({ success: false, error: error.message });
    return;
  }
  res.json({ success: true });
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Aucun fichier envoyé." });
    return;
  }
  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(file.path);
  } catch (err) {
    res.status(500).json({ error: "Erreur lecture fichier temporaire." });
    return;
  }
  const fileName = `${Date.now()}-${normalizeFileName(file.originalname)}`;
  try {
    const { error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(fileName, fileBuffer, {
        contentType: file.mimetype,
        upsert: true,
      });
    if (uploadError) {
      console.error("Erreur Supabase upload :", uploadError.message);
      res.status(500).json({ error: uploadError.message });
      return;
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
  const { titre, description, contenu } = req.body;
  const file = req.file;
  if (!titre || !description || !contenu || !file) {
    res.status(400).json({ error: "Champs manquants" });
    return;
  }
  const fileName = `${Date.now()}-${normalizeFileName(file.originalname)}`;
  try {
    const { error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });
    if (uploadError) {
      console.error("❌ Erreur upload image :", uploadError.message);
      res.status(500).json({ error: "Erreur upload image Supabase." });
      return;
    }
    const { publicUrl } = supabase.storage
      .from("uploads")
      .getPublicUrl(fileName).data;
    const { error: dbError } = await supabase.from("fil_actualite").insert([
      {
        titre,
        description,
        contenu,
        image_url: publicUrl,
      },
    ]);
    if (dbError) {
      console.error("❌ Erreur insertion actualité :", dbError.message);
      res.status(500).json({ error: dbError.message });
      return;
    }
    res.json({ success: true, image_url: publicUrl });
  } catch (err) {
    console.error("❌ Erreur serveur :", err.message);
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
    console.error("Erreur récupération catégories :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ajouter une question/réponse à la FAQ
app.post("/api/faq", async (req, res) => {
  const { question, reponse } = req.body;
  if (!question || !reponse) {
    res.status(400).json({ error: "Question et réponse requises." });
    return;
  }
  const { data, error } = await supabase
    .from("faq")
    .insert([{ question, reponse }])
    .select()
    .single();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, faq: data });
});

// Modifier une question/réponse de la FAQ
app.put("/api/faq/:id", async (req, res) => {
  const { id } = req.params;
  const { question, reponse } = req.body;
  if (!question && !reponse) {
    res.status(400).json({ error: "Aucune donnée à mettre à jour." });
    return;
  }
  const updateObj = {};
  if (question) updateObj.question = question;
  if (reponse) updateObj.reponse = reponse;
  const { error } = await supabase.from("faq").update(updateObj).eq("id", id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true });
});

// Supprimer une question/réponse de la FAQ
app.delete("/api/faq/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("faq").delete().eq("id", id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true });
});

// Ajouter un partenaire
app.post("/api/partenaires", async (req, res) => {
  const { nom, description, url, logo_url } = req.body;
  if (!nom) {
    res.status(400).json({ error: "Le nom du partenaire est requis." });
    return;
  }
  const { data, error } = await supabase
    .from("partenaires")
    .insert([{ nom, description, url, logo_url }])
    .select()
    .single();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, partenaire: data });
});

// Modifier un partenaire
app.put("/api/partenaires/:id", async (req, res) => {
  const { id } = req.params;
  const { nom, description, url, logo_url } = req.body;
  if (!nom && !description && !url && !logo_url) {
    res.status(400).json({ error: "Aucune donnée à mettre à jour." });
    return;
  }
  const updateObj = {};
  if (nom) updateObj.nom = nom;
  if (description) updateObj.description = description;
  if (url) updateObj.url = url;
  if (logo_url) updateObj.logo_url = logo_url;
  const { error } = await supabase
    .from("partenaires")
    .update(updateObj)
    .eq("id", id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true });
});

// Supprimer un partenaire
app.delete("/api/partenaires/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("partenaires").delete().eq("id", id);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true });
});

// Ajouter un article de presse
app.post("/api/presse", upload.single("image"), async (req, res) => {
  const { titre, source, date_publication } = req.body;
  const file = req.file;

  if (!titre || !file) {
    return res.status(400).json({ error: "Champs manquants (titre ou image)" });
  }

  const fileName = `${Date.now()}-${normalizeFileName(file.originalname)}`;

  try {
    const fileBuffer = fs.readFileSync(file.path);

    const { error: uploadError } = await supabase.storage
      .from("presse")
      .upload(fileName, fileBuffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error("❌ Erreur upload image :", uploadError.message);
      return res.status(500).json({ error: "Erreur upload image Supabase." });
    }

    const { publicUrl } = supabase.storage
      .from("presse")
      .getPublicUrl(fileName).data;

    try {
      fs.unlinkSync(file.path);
    } catch (err) {
      console.warn(
        "⚠️ Impossible de supprimer le fichier local :",
        err.message
      );
    }

    const { data, error: dbError } = await supabase
      .from("presse")
      .insert([
        {
          titre,
          image_url: publicUrl,
          image_path: fileName,
          source: source || null,
          date_publication: date_publication || null,
        },
      ])
      .select()
      .single();

    if (dbError) {
      console.error("❌ Erreur insertion base :", dbError.message);
      return res.status(500).json({ error: dbError.message });
    }

    res.json({ success: true, article: data });
  } catch (err) {
    console.error("❌ Erreur serveur :", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Modifier un article de presse
app.put("/api/presse/:id", upload.single("image"), async (req, res) => {
  const { id } = req.params;
  const { titre, source, date_publication } = req.body;
  let updateObj = { titre, source, date_publication };

  // Nettoyage des champs vides
  Object.keys(updateObj).forEach(
    (key) =>
      (updateObj[key] === undefined || updateObj[key] === "") &&
      delete updateObj[key]
  );

  let newImageUrl = null;
  let newImagePath = null;

  if (req.file) {
    try {
      // Supprimer l'ancienne image
      const { data: old, error: oldError } = await supabase
        .from("presse")
        .select("image_path")
        .eq("id", id)
        .single();

      if (old && old.image_path) {
        await supabase.storage.from("presse").remove([old.image_path]);
      }

      const fileBuffer = fs.readFileSync(req.file.path);
      const fileName = `${Date.now()}-${normalizeFileName(
        req.file.originalname
      )}`;

      const { error: uploadError } = await supabase.storage
        .from("presse")
        .upload(fileName, fileBuffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        return res.status(500).json({ error: uploadError.message });
      }

      const { publicUrl } = supabase.storage
        .from("presse")
        .getPublicUrl(fileName).data;

      newImageUrl = publicUrl;
      newImagePath = fileName;

      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {
        console.warn(
          "⚠️ Impossible de supprimer le fichier local :",
          err.message
        );
      }
    } catch (err) {
      return res
        .status(500)
        .json({ error: "Erreur upload image : " + err.message });
    }
  }

  if (newImageUrl) updateObj.image_url = newImageUrl;
  if (newImagePath) updateObj.image_path = newImagePath;

  const { error } = await supabase
    .from("presse")
    .update(updateObj)
    .eq("id", id);

  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }

  res.json({ success: true });
});

// Supprimer un article de presse
app.delete("/api/presse/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data: article, error: fetchError } = await supabase
      .from("presse")
      .select("image_path")
      .eq("id", id)
      .single();

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    if (article && article.image_path) {
      await supabase.storage.from("presse").remove([article.image_path]);
    }

    const { error } = await supabase.from("presse").delete().eq("id", id);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lanceement du serveur
app.listen(3001, () => {
  console.log("🚀 API démarrée sur https://render-pfyp.onrender.com/");
});
