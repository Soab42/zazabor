import React, { useEffect, useState } from "react";
import { getDatabase, query, ref, get } from "firebase/database";
import { app } from "../firebase";

// import ReceiptIcon from "@mui/icons-material/Receipt";
import { Delete, Edit } from "@mui/icons-material";
import { Link } from "react-router-dom";
export default function Productlist() {
  const [product, setProduct] = useState([]);
  const [key, setKey] = useState([]);

  useEffect(() => {
    async function fetchVideos() {
      // database related works
      const db = getDatabase(app);
      const prodRef = ref(db, "productlist");
      const prodQuery = query(prodRef);

      try {
        // request firebase database
        const snapshot = await get(prodQuery);
        if (snapshot.exists()) {
          setProduct(Object.values(snapshot.val()));
          setKey(Object.keys(snapshot.val()));
        }
      } catch (err) {
        console.log(err);
      }
    }

    fetchVideos();
  }, []);
  return (
    <div>
      <table className="w-full text-center capitalize">
        <tr>
          <th>sl no</th>

          <th>id</th>
          <th>name</th>
          <th>price</th>
          <th>discount</th>
          <th>imgurl</th>
          <th>action</th>
        </tr>

        {product.map((x, index) => (
          <tr>
            <td>{index + 1}</td>
            <td>{x.id}</td>
            <td>{x.name}</td>
            <td>{x.price}</td>
            <td>{x.discount}</td>
            <td>{x.imgUrl.slice(12)}</td>
            <td className="flex gap-2 justify-center capitalize">
              <Link to={`/edit/${key[index]}`} className="flex gap-2">
                <Edit />
                <p className="hidden md:flex" onClick={() => {}}>
                  edit
                </p>
              </Link>
              <p className="flex gap-2 text-red-400">
                <Delete />
                <p className="hidden md:flex">delete</p>
              </p>
            </td>
          </tr>
        ))}
      </table>
    </div>
  );
}
