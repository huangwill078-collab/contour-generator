
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // GEO
    if (url.pathname === "/api/geocode") {
      const q = url.searchParams.get("q");
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (!data?.length) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon)
      });
    }

    // OVERPASS
    if (url.pathname === "/api/overpass") {
      const body = await request.text();
      const r = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body
      });
      return new Response(await r.text(), {
        headers: { "content-type": "application/json" }
      });
    }

    // TILE PROXY (OSM)
    if (url.pathname.startsWith("/api/tile")) {
      const path = url.pathname.replace("/api/tile/", "");
      return fetch(`https://tile.openstreetmap.org/${path}`);
    }

    // DEM (placeholder proxy - Terrarium RGB)
    if (url.pathname.startsWith("/api/dem")) {
      const bbox = url.searchParams.get("bbox");
      return Response.json({ bbox, note: "connect real DEM source if needed" });
    }

    return new Response("Not Found", { status: 404 });
  }
};
