import os
import duckdb
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
TEMPERATURES_FILE = os.path.join(DATA_DIR, "temperatures_2019.parquet")
METADATA_FILE = os.path.join(DATA_DIR, "meta_clusters_combined.parquet")


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"},
    )


def query_parquet(path: str) -> Response:
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"File not found: {os.path.basename(path)}")
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM read_parquet('{path}')").fetchdf()
    con.close()
    return Response(
        content=df.to_json(orient="records"),
        media_type="application/json",
    )


@app.get("/data/timeseries")
def get_timeseries():
    return query_parquet(TEMPERATURES_FILE)


@app.get("/data/metadata")
def get_metadata():
    return query_parquet(METADATA_FILE)


@app.get("/health")
def health():
    return {
        "timeseries": os.path.exists(TEMPERATURES_FILE),
        "metadata": os.path.exists(METADATA_FILE),
    }
