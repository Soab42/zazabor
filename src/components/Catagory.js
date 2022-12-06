import React, { useEffect, useState } from "react";
import { getDatabase, query, ref, get } from "firebase/database";
import { app } from "../firebase";
import { Search } from "@mui/icons-material";
import Productlist from "../page/Productlist";

export default function Catagory() {
  const db = getDatabase(app);
  const [cat, setCat] = useState();
  const [catagorylist, setCatagorylist] = useState();
  const [catagory, setCatagory] = useState([]);
  // console.log(catagory);

  useEffect(() => {
    async function fetchVideos() {
      // database related works
      const prodRef = ref(db, "productlist");
      const prodQuery = query(prodRef);
      try {
        // request firebase database
        const snapshot = await get(prodQuery);
        if (snapshot.exists()) {
          setCatagory(Object.keys(snapshot.val()));
        }
      } catch (err) {
        console.log(err);
      }
    }
    fetchVideos();
  }, [db]);

  return (
    <div>
      <div>
        <label>
          <form
            className="flex gap-2 mb-10"
            onSubmit={(e) => {
              e.preventDefault();
              setCatagorylist(cat);
            }}
          >
            <select
              type={"select"}
              className={"text-center text-black capitalize px-2"}
              required
              placeholder="catagory name"
              onChange={(e) => {
                setCat(e.target.value);
              }}
            >
              <option className="text-center justify-center" value={null}>
                select catagory
              </option>
              {catagory.map((x) => (
                <option value={x}>{x}</option>
              ))}
            </select>
            <button className="bg-green-200 text-black px-2 py-1 flex gap-2 items-center capitalize">
              <Search />
              <p>search</p>
            </button>
          </form>
        </label>
      </div>
      <div>
        <Productlist catagory={catagorylist} />
      </div>
    </div>
  );
}
