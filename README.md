# English Shadowing (Chrome Extension)

Extension Chrome Manifest V3 moderne pour pratiquer la prononciation et le shadowing en anglais directement sur n'importe quelle page web : sélectionnez du texte, écoutez avec des voix naturelles US/UK, répétez, enregistrez-vous et comparez votre prononciation.

---

## 🚀 Démarrage Rapide

### 1. Installation des dépendances

```bash
cd extension
npm install
```

### 2. Lancement automatique dans Chrome

Un script utilitaire permet de compiler et de lancer directement une instance de Google Chrome avec l'extension pré-chargée :

```bash
cd extension

# Build + lancement de Chrome
node scripts/launch.mjs

# Ou en mode dev continu (rechargement automatique)
node scripts/launch.mjs --dev
```

---

## 🛠️ Développement & Rechargement (Hot Reload)

### Comment fonctionne le rechargement ?

> **Doit-on recharger l'extension manuellement ?**
> 
> - **En mode développement (`npm run dev`) : NON !**  
>   Le framework **WXT** gère le rechargement à chaud (HMR & auto-reload). Dès que vous sauvegardez un fichier dans `src/`, l'extension se met à jour automatiquement dans Chrome.
> - **En mode build standard (`npm run build`) : OUI.**  
>   Si vous compilez manuellement avec `npm run build`, allez sur `chrome://extensions` et cliquez sur l'icône de rafraîchissement 🔄 sur la carte de l'extension, puis rechargez votre page web de test (F5).

### Commandes principales

Toutes les commandes s'exécutent dans le dossier `extension/` :

```bash
cd extension

# Lancer le serveur de développement avec rechargement automatique
npm run dev

# Compiler pour la production (génère .output/chrome-mv3)
npm run build

# Lancer la suite de tests unitaires (Vitest)
npm test

# Lancer les vérifications complètes (TypeScript, ESLint, tests, scripts)
npm run verify

# Vérifier et corriger le style de code
npm run lint:fix
```

---

## 📦 Installer l'extension manuellement dans Chrome

1. Compilez le projet si ce n'est pas déjà fait :
   ```bash
   cd extension
   npm run build
   ```
2. Ouvrez Google Chrome et rendez-vous sur :  
   `chrome://extensions`
3. Activez le **Mode développeur** (interrupteur en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** (bouton en haut à gauche).
5. Sélectionnez le dossier généré :  
   `project-en-learner/extension/.output/chrome-mv3`

---

## ✨ Fonctionnalités Clés

- **Micro-bouton contextuel** : Apparaît discrètement au survol/sélection de n'importe quel mot ou phrase sur le web.
- **Bulle rapide (Quick-read Pop-up)** :
  - Définition du mot et transcription phonétique (IPA) avec syllabe accentuée mise en valeur.
  - Synthèse vocale instantanée (US / UK) avec contrôle du débit.
- **Panneau latéral (Side Panel)** :
  - **Pratique & Shadowing** : Écoute avec boucle de répétition paramétrable (nombre de rounds, délai de pause).
  - **Enregistrement vocal** : Enregistrez votre prise et observez le retour mot à mot.
  - **Comparaison A/B** : Écoutez alternativement le modèle natif et votre propre enregistrement.
- **Vocabulaire sauvegardé & Révision** :
  - Cartes mémoires (Flashcards) avec système de répétition espacée (boîtes de Leitner 1 à 5).
  - Export et import des listes de vocabulaire au format JSON.
- **Respect absolu de la vie privée** :
  - Fonctionne entièrement sur votre appareil.
  - Aucun compte, aucun abonnement, aucun tracking, aucune donnée envoyée à des serveurs tiers payants.

---

## 📁 Structure du Projet

```text
project-en-learner/
├── extension/                       # Code source de l'extension Chrome
│   ├── public/                      # Dictionnaires hors-ligne, icônes et locales
│   │   ├── _locales/                # Fichiers i18n (français et anglais)
│   │   └── dict/                    # Dictionnaire local CMUdict (binaire et JSON)
│   ├── src/
│   │   ├── content/                 # Content scripts (micro-bouton, pop-up shadow DOM)
│   │   ├── sidepanel/               # Interface du panneau latéral (Pratique, Sauvegardes, Réglages)
│   │   ├── services/                # Moteurs TTS, enregistreur audio, reconnaissance vocale
│   │   ├── ipa/                     # Transcription phonétique et alignement de texte
│   │   ├── shared/                  # Types de messages, stockage et requêtes
│   │   └── ui/                      # Icônes SVG et helpers Shadow DOM
│   ├── scripts/                     # Scripts de compilation, tests de validation et lancement
│   ├── tests/                       # Suite complète de tests unitaires Vitest (370+ tests)
│   └── docs/                        # Spécifications et documentation technique
│       ├── SPEC_V2.md               # Spécifications de la version v2 (IA locale)
│       ├── DECISIONS.md             # Journal des décisions architecturales
│       └── PRIVACY.md               # Politique de confidentialité et permissions
└── eval/                            # Banc d'évaluation expérimental (modèles Whisper & phonèmes)
```

---

## 🗺️ Roadmap v2 (En cours)

La version **v2** introduit des modèles d'IA légers fonctionnant directement sur l'appareil de l'utilisateur (on-device ML, coût serveur zéro) :
- **Synthèse vocale neuronale** (Kokoro TTS / WebGPU).
- **Dictionnaire hors-ligne étendu**.
- **Reconnaissance automatique locale** (Whisper on-device) et scoring phonétique.
- **Explication de phrases en contexte** via les API Chrome Built-in AI (Prompt API).
