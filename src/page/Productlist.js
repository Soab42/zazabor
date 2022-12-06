import React, { useEffect, useState } from "react";
import { getDatabase, query, ref, get, remove } from "firebase/database";
import { app } from "../firebase";

// import Icon from "@mui/icons-material";
import { Delete, Edit } from "@mui/icons-material";
import { Link } from "react-router-dom";

export default function Productlist({ catagory }) {
  const [product, setProduct] = useState([]);
  const [key, setKey] = useState([]);

  const db = getDatabase(app);

  useEffect(() => {
    async function fetchVideos() {
      // database related works

      const prodRef = ref(db, "productlist/" + catagory);
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
  }, [db, catagory]);

  return (
    <div>
      <table className="w-full text-center capitalize">
        <tr className=" ">
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
            <td className="flex justify-center">
              <img
                className="h-20 object-contain rounded-sm"
                src={`product/${x.imgUrl.slice(12)}`}
                alt=""
              />
            </td>
            <td className="w-1/6">
              <p className="flex gap-2 justify-center items-center ">
                <Link
                  to={`/${catagory}/${key[index]}`}
                  className="border-r-2 border-green-200 text-blue-400 pr-3 flex gap-2"
                >
                  <Edit />
                  <p className="hidden md:flex" onClick={() => {}}>
                    edit
                  </p>
                </Link>

                <Link
                  onClick={() => {
                    remove(
                      ref(db, "productlist/" + catagory + "/" + key[index])
                    )
                      .then((data) => {
                        //success callback
                        alert("success" + data);
                      })
                      .catch((error) => {
                        //error callback
                        alert("failed" + error);
                      });
                  }}
                  className="flex gap-2 text-red-400"
                >
                  <Delete />
                  <p className="hidden md:flex">delete</p>
                </Link>
              </p>
            </td>
          </tr>
        ))}
      </table>
    </div>
  );
}
