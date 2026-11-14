import { useState } from "react";
import { Database, FileJson2, FileSpreadsheet, UploadCloud } from "lucide-react";

export function IngestionView({ importing, onFile }: { importing: boolean; onFile: (file?: File) => void }) {
  const [dragging, setDragging] = useState(false);
  return <section className="panel ingestion-panel"><div className="ingestion-title"><span className="ingestion-icon"><UploadCloud size={20}/></span><div className="eyebrow">DATOS DE FLOTA / INGESTA</div><h2>Incorpora registros de origen a la flota</h2><p>Los archivos CSV y JSON comparten validación y normalización de maquinaria.</p></div>
    <label className={`drop-area${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); onFile(event.dataTransfer.files[0]); }}>
      <input type="file" accept=".csv,.json,text/csv,application/json" disabled={importing} onChange={(event) => { onFile(event.target.files?.[0]); event.currentTarget.value = ""; }}/>
      <span className="upload-outline"><UploadCloud size={18}/></span><b>{importing ? "Importando archivo de origen…" : "Suelta un archivo aquí o búscalo"}</b><span>CSV o JSON · El tamaño máximo depende de la configuración de la API</span><span className="button button-secondary">Seleccionar archivo</span>
    </label>
    <div className="format-grid"><article><FileSpreadsheet size={17}/><b>Origen CSV</b><span>Los encabezados se asignan a los campos normalizados de máquina que admite la API.</span></article><article><FileJson2 size={17}/><b>Origen JSON</b><span>Los registros JSON siguen el mismo contrato de normalización y actualización.</span></article></div>
    <div className="ingestion-note"><Database size={14}/> Los registros aceptados se actualizan por identificador de máquina. El servicio informa las filas rechazadas y la URI del archivo original.</div>
  </section>;
}
