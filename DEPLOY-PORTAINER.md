# Deploy en Portainer vía Git (sin Docker Hub)

Portainer clona este repo y construye la imagen él mismo. No hace falta registry.

## 1. Subir el proyecto a un repo Git

Creá un repositorio **privado** en GitHub/GitLab (privado porque, aunque las credenciales
están excluidas por `.gitignore`, es buena práctica) y subí el código:

```powershell
cd C:\Projects\brosco-actual-sync
git remote add origin https://github.com/TU_USUARIO/brosco-actual-sync.git
git branch -M main
git push -u origin main
```

## 2. Crear el Stack en Portainer

1. **Stacks → Add stack**
2. Nombre: `brosco-sync`
3. Build method: **Repository**
4. Completá:
   - **Repository URL**: `https://github.com/TU_USUARIO/brosco-actual-sync`
   - **Repository reference**: `refs/heads/main`
   - **Compose path**: `docker-compose.yml`
   - Si el repo es privado → activá **Authentication** y poné tu usuario + token de acceso
5. **Deploy the stack**

Portainer clona, compila el Dockerfile y levanta el contenedor.

## 3. Configurar

1. Abrí `http://IP_DEL_VPS:3000`
2. Tab **Configuración** → credenciales Brosco + Actual + Sync ID + (opcional) Claude API key
3. Tab **Cuentas** → vinculá cada cuenta Brosco con una de Actual
4. **Sincronizar ahora**

La config se guarda en `sync-data/` dentro del stack y persiste entre reinicios.

## 4. Actualizar

```powershell
git add -A && git commit -m "cambios" && git push
```
En Portainer: **Stacks → brosco-sync → Pull and redeploy**.
(O activá **GitOps updates / Automatic updates** para que se actualice solo con cada push.)

## Notas
- **Puerto ocupado**: cambiá `"3000:3000"` por `"8080:3000"` en `docker-compose.yml`.
- **HTTPS / exposición pública**: poné un reverse proxy (Nginx Proxy Manager / Traefik)
  con autenticación delante. La UI contiene tus credenciales — no la expongas sin proteger.
- **Backup**: respaldá la carpeta `sync-data/` del stack (tiene `config.json` y el caché de categorías).
