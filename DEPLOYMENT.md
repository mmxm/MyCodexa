# Guide de Déploiement et de Mise à jour - Codexa sur Alwaysdata

Ce dépôt est un fork personnalisé du projet [Codexa](https://github.com/thehijacker/codexa) configuré pour être hébergé sur Alwaysdata à l'adresse `http://elwood.alwaysdata.net`.

---

## 1. Spécificités du Serveur (Alwaysdata)

* **Chemin de l'application** : `/home/elwood/MyCodexa`
* **Version Node.js** : >= 24 (configurée via l'espace d'administration Alwaysdata).
* **Base de données** : SQLite située dans `data/codexa.db`.
* **Particularité Alwaysdata** : Les connexions SSH et les processus serveurs HTTP (uWSGI/Passenger) s'exécutent dans des espaces séparés. Tenter de tuer ou relancer les processus Node.js depuis SSH (`pkill`, etc.) ne fonctionnera pas ou n'affectera pas le serveur HTTP. **Le redémarrage du site doit être effectué via le bouton "Restart" dans la section Web > Sites de la console Alwaysdata.**

---

## 2. Modification Personnalisée à Conserver

Une modification essentielle a été apportée dans `public/js/bookorbit.js` (commit initial : `8e895e6d` par François Lesecq).

### Description de la modification :
Lors de l'affichage de l'aperçu ("Peek") ou de l'importation de livres depuis une instance BookOrbit connectée, Codexa sélectionne par défaut le tout premier fichier de la liste (`book.files?.[0]`). Si ce fichier est une image (couverture) ou un format non supporté par Codexa, l'import échoue.

Le code a été modifié à deux endroits dans `public/js/bookorbit.js` (`renderPeekButton` et `renderCardActions`) :
```javascript
const primaryFile = book.files?.find(f => f.role === 'primary') || 
                    book.files?.find(f => ['epub', 'cbz', 'cbr'].includes(String(f.format || '').toLowerCase().replace(/^\./, ''))) || 
                    book.files?.[0];
```
Cette modification cherche d'abord le fichier marqué comme principal (`primary`), puis un fichier dans un format ebook pris en charge (`epub`, `cbz`, `cbr`), avant de se replier sur le premier fichier par défaut.

**IMPORTANT :** Lors de toute fusion future avec le dépôt officiel (upstream), assurez-vous que cette logique n'est pas écrasée.

---

## 3. Procédure de Mise à jour (pour les futurs agents)

Pour mettre à jour Codexa avec la dernière version officielle tout en conservant la configuration et le correctif personnalisé, suivez scrupuleusement ces étapes :

### Étape 1 : Sauvegarde de la Base de Données
Avant toute manipulation, connectez-vous en SSH et effectuez une sauvegarde propre à chaud/à froid de la base de données :
```bash
python3 -c "
import sqlite3
src = sqlite3.connect('/home/elwood/MyCodexa/data/codexa.db')
dst = sqlite3.connect('/home/elwood/MyCodexa/data/codexa.db.backup')
with dst:
    src.backup(dst)
print('Sauvegarde SQLite OK.')
"
```

### Étape 2 : Fusion (Merge) de la version Upstream
La machine locale de l'utilisateur dispose des accès SSH requis pour pousser sur le dépôt GitHub `origin`. Il est préférable d'effectuer la fusion localement sur sa machine de la façon suivante :
1. Cloner le dépôt sur la machine locale :
   `git clone git@github.com:mmxm/MyCodexa.git`
2. Ajouter le dépôt de référence amont (s'il n'est pas déjà présent) :
   `git remote add upstream https://github.com/thehijacker/codexa.git`
3. Récupérer les branches officielles de l'amont :
   `git fetch upstream`
4. Fusionner la version cible (ex: `upstream/main`) dans votre branche locale :
   `git merge upstream/main`
5. Vérifier et résoudre les conflits éventuels dans `public/js/bookorbit.js` en veillant à conserver la logique de sélection intelligente du fichier principal `primaryFile` détaillée à la section 2 de ce guide.
6. Pousser (push) le résultat de la fusion sur GitHub :
   `git push origin main`

### Étape 3 : Déploiement sur le Serveur
Une fois la fusion poussée sur GitHub :
1. Connectez-vous en SSH sur le serveur Alwaysdata.
2. Naviguez vers `/home/elwood/MyCodexa`.
3. Récupérez la nouvelle version :
   `git pull origin main`
4. Installez les dépendances npm mises à jour :
   `npm install`
5. Compilez le frontend (transpilation esbuild vers `dist/`) :
   `npm run build`

### Étape 4 : Redémarrage
Demandez à l'utilisateur de se connecter à sa console d'administration Alwaysdata (Web > Sites) et de cliquer sur **Restart** (Redémarrer) sur le site Codexa afin que le nouveau code Node.js soit exécuté. Les migrations de base de données s'exécutent automatiquement au premier chargement.
